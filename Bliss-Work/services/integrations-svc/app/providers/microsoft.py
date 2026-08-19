"""Microsoft Graph adapter — Outlook mail and Teams chat.

Both providers run on one Entra app registration (see app_credentials), so one
module covers them. Shape mirrors slack.py/gmail.py: module timeout, one
CircuitBreaker, every call through retry_async, three error classes that route
to different recovery paths.

  MicrosoftAuthError (401)  — token expired. NOT a broken connection: the caller
                              enrolls it for the existing refresh_worker sweep.
  MicrosoftRateLimited(429) — Graph is aggressive about throttling and almost
                              always supplies Retry-After. Honor it.
  MicrosoftError            — definitive.

TWO GRAPH BEHAVIORS THAT WILL BITE IF FORGOTTEN
───────────────────────────────────────────────
1. DELTA PAGING. A delta query returns `@odata.nextLink` while more pages
   remain and `@odata.deltaLink` only on the LAST page. Persisting a half-walked
   nextLink as the cursor silently skips every message after that point, and it
   looks like it works. `walk_delta` below refuses to return a cursor until it
   sees the deltaLink.

2. TEAMS SUBSCRIPTION SCOPE. `/chats/getAllMessages` (tenant-wide) needs
   Microsoft "Protected API" approval — a separate application process with
   Microsoft, not just an admin consent click. We subscribe PER CHAT to
   `/chats/{id}/messages`, which works with ordinary delegated permission. The
   cost is more subscriptions to renew, and chat subscriptions expire in
   ~60 minutes rather than days.
"""
from __future__ import annotations

import hmac
from datetime import datetime, timedelta, timezone

import httpx

from ..resilience import CircuitBreaker, retry_async

_GRAPH = "https://graph.microsoft.com/v1.0"
_TIMEOUT = 15.0
_ms_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="microsoft")

#: Graph caps subscription lifetime per resource type and rejects anything
#: longer. Mail tolerates ~3 days (spec says 4230 minutes); chat messages are
#: ~60 minutes. We request slightly under the max so clock skew between us and
#: Graph can't push the request over the limit.
MAIL_SUBSCRIPTION_MINUTES = 4230 - 60
CHAT_SUBSCRIPTION_MINUTES = 60 - 5

#: Renew this long before expiry. A subscription that lapses stops delivering
#: silently — there is no error, notifications simply stop — so the margin is
#: generous relative to the worker's sweep interval.
RENEW_MARGIN_MINUTES = 15


class MicrosoftError(Exception):
    """A definitive Graph failure — retrying will not help."""


class MicrosoftAuthError(MicrosoftError):
    """401: the access token is expired or revoked. Enroll for refresh."""


class MicrosoftRateLimited(MicrosoftError):
    """429/503: back off. `retry_after` is seconds when Graph supplied one."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _raise_for_status(r: httpx.Response) -> None:
    if r.status_code < 400:
        return
    try:
        body = r.json()
        err = body.get("error", {}) if isinstance(body, dict) else {}
        msg = err.get("message") or r.text
    except ValueError:
        msg = r.text

    if r.status_code == 401:
        raise MicrosoftAuthError(msg)

    retry_after = r.headers.get("Retry-After")
    delay: float | None = None
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            delay = None

    # 503/504 with Retry-After is Graph shedding load, not a permanent failure.
    if r.status_code in (429, 503, 504):
        raise MicrosoftRateLimited(msg, delay)

    raise MicrosoftError(f"{r.status_code}: {msg}")


async def _request(
    token: str, method: str, url: str, *, extra_headers: dict[str, str] | None = None, **kw
) -> dict:
    """`url` may be absolute (a nextLink/deltaLink Graph handed us) or a path."""
    full = url if url.startswith("http") else f"{_GRAPH}{url}"
    headers = {"Authorization": f"Bearer {token}", **(extra_headers or {})}

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.request(method, full, headers=headers, **kw)
            _raise_for_status(r)
            return r.json() if r.content else {}

    return await retry_async(_attempt, attempts=3, breaker=_ms_breaker)


# ── identity ──────────────────────────────────────────────────────────────────
async def me(token: str) -> dict:
    """The signed-in user: id (AAD object id), mail, userPrincipalName.

    The `id` matters as much as the address — Teams mentions reference the AAD
    object id, so a connection that registered only the mailbox would never
    match a Teams mention.
    """
    return await _request(token, "GET", "/me")


# ── subscriptions ─────────────────────────────────────────────────────────────
def subscription_expiry(minutes: int, *, now: datetime | None = None) -> str:
    """Graph wants an ISO-8601 UTC instant with a trailing Z."""
    base = now or datetime.now(timezone.utc)
    return (base + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.0000000Z")


async def create_subscription(
    token: str,
    *,
    resource: str,
    notification_url: str,
    client_state: str,
    minutes: int,
) -> dict:
    """Subscribe to change notifications for `resource`.

    Graph VALIDATES notification_url synchronously during this call: it POSTs a
    validationToken to it and expects the token echoed back as text/plain within
    10 seconds. If our receiver is unreachable or slow, this fails here — which
    is a much better place to find out than in production silence.
    """
    return await _request(
        token,
        "POST",
        "/subscriptions",
        json={
            "changeType": "created",
            "notificationUrl": notification_url,
            "resource": resource,
            "expirationDateTime": subscription_expiry(minutes),
            "clientState": client_state,
        },
    )


async def renew_subscription(token: str, subscription_id: str, *, minutes: int) -> dict:
    """Extend a subscription's expiry. Cheaper and less disruptive than
    recreating: the subscription id and clientState stay stable."""
    return await _request(
        token,
        "PATCH",
        f"/subscriptions/{subscription_id}",
        json={"expirationDateTime": subscription_expiry(minutes)},
    )


async def delete_subscription(token: str, subscription_id: str) -> None:
    """Unsubscribe on disconnect so Graph stops posting to a dead endpoint."""
    await _request(token, "DELETE", f"/subscriptions/{subscription_id}")


def verify_client_state(expected: str, received: str | None) -> bool:
    """Constant-time compare of the notification's clientState.

    This is the ONLY thing authenticating a Graph notification — the endpoint is
    public and the payload is otherwise unauthenticated. A plain `==` leaks
    timing, so compare_digest it, and fail closed on anything missing.
    """
    if not expected or not received:
        return False
    return hmac.compare_digest(expected, received)


# ── reading ───────────────────────────────────────────────────────────────────
async def walk_delta(token: str, url: str, *, max_pages: int = 50) -> tuple[list[dict], str | None]:
    """Follow `@odata.nextLink` until a page carries `@odata.deltaLink`.

    Returns (items, delta_link). **delta_link is None when the walk did not
    finish** — callers MUST NOT persist a cursor in that case, because storing a
    half-walked position silently skips every message beyond it. Re-fetching the
    same pages next sweep is harmless; the ingest dedup index absorbs it.

    `max_pages` bounds a first sync on a large mailbox so one connection can't
    monopolize the worker.
    """
    items: list[dict] = []
    next_url: str | None = url

    for _ in range(max_pages):
        if not next_url:
            break
        page = await _request(token, "GET", next_url)
        items.extend(page.get("value", []) or [])

        delta_link = page.get("@odata.deltaLink")
        if delta_link:
            return items, str(delta_link)
        next_url = page.get("@odata.nextLink")

    # Ran out of pages (or links) without reaching the end of the delta.
    return items, None


def inbox_delta_url() -> str:
    """Starting delta URL for the mailbox inbox.

    `$select` is not an optimization here: without it Graph returns the full
    message including `body`, and mention detection only needs the addressing
    fields and the bulk-mail markers.
    """
    return (
        "/me/mailFolders('inbox')/messages/delta"
        "?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,"
        "internetMessageId,conversationId,webLink,isDraft"
    )


async def get_message(token: str, message_id: str, *, as_text: bool = False) -> dict:
    """One mail in full, including the body the inbox delta deliberately omits.

    `as_text` asks Graph to convert the body to plain text rather than returning
    the HTML it was sent as. That conversion is worth having done by Microsoft:
    the alternative is an HTML-to-text pass of our own over untrusted markup,
    and the BlissWork inbox renders text, never a sender's HTML.
    """
    headers = {"Prefer": 'outlook.body-content-type="text"'} if as_text else None
    return await _request(token, "GET", f"/me/messages/{message_id}", extra_headers=headers)


async def list_chats(token: str, *, top: int = 50) -> list[dict]:
    """The user's chats. Each needs its own subscription — see the module note
    about /chats/getAllMessages requiring Protected API approval."""
    page = await _request(token, "GET", f"/me/chats?$top={top}")
    return page.get("value", []) or []


async def get_chat_message(token: str, chat_id: str, message_id: str) -> dict:
    return await _request(token, "GET", f"/chats/{chat_id}/messages/{message_id}")


# ── sending ───────────────────────────────────────────────────────────────────
async def send_mail(token: str, *, to: str, subject: str, body: str) -> None:
    """Send Outlook mail.

    Graph answers 202 with an EMPTY body — there is no message id to return.
    Callers must therefore write the activity mirror with external_id = None,
    which the partial unique index on external_id_bidx tolerates (it only covers
    non-null values).
    """
    await _request(
        token,
        "POST",
        "/me/sendMail",
        json={
            "message": {
                "subject": subject,
                "body": {"contentType": "Text", "content": body},
                "toRecipients": [{"emailAddress": {"address": to}}],
            },
            "saveToSentItems": True,
        },
    )


async def send_chat_message(token: str, chat_id: str, text: str) -> dict:
    """Post to a Teams chat. Returns the created message (with its id)."""
    return await _request(
        token,
        "POST",
        f"/chats/{chat_id}/messages",
        json={"body": {"contentType": "text", "content": text}},
    )


# ── helpers ───────────────────────────────────────────────────────────────────
def addresses_of(message: dict) -> tuple[str, list[str], list[str]]:
    """(from, to[], cc[]) from a Graph mail resource, lowercased.

    Graph nests every address two levels deep and omits the collection entirely
    when empty, so each level needs a guard.
    """

    def _addr(entry: dict) -> str:
        return str(((entry or {}).get("emailAddress") or {}).get("address") or "").lower()

    sender = _addr(message.get("from") or {})
    to = [a for a in (_addr(e) for e in message.get("toRecipients") or []) if a]
    cc = [a for a in (_addr(e) for e in message.get("ccRecipients") or []) if a]
    return sender, to, cc


def mentioned_user_ids(chat_message: dict) -> list[str]:
    """AAD object ids explicitly @-mentioned in a Teams message.

    Only `mentioned.user` counts. `mentioned.conversation` is an @team/@channel
    broadcast, which is exactly the firehose the mentions feed exists to
    replace, and `mentioned.application` is a bot.
    """
    ids: list[str] = []
    seen: set[str] = set()
    for m in chat_message.get("mentions", []) or []:
        user = (m.get("mentioned") or {}).get("user") or {}
        uid = str(user.get("id") or "")
        if uid and uid not in seen:
            seen.add(uid)
            ids.append(uid)
    return ids


def is_from_bot(chat_message: dict) -> bool:
    """True when a Teams message came from an application rather than a person.

    A bot echoing our own forwarded message must not be ingested as a mention —
    that is how a message loop starts.
    """
    frm = chat_message.get("from") or {}
    return bool(frm.get("application")) or not frm.get("user")
