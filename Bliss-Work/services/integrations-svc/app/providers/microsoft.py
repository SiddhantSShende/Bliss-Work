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

2. SEND IS DRAFT-THEN-SEND, NOT /sendMail. `send_mail` creates a draft (which
   Graph gives an `id` and assigns an `internetMessageId` to) and only then
   sends it, instead of the simpler single-call `/me/sendMail`. This is the
   mechanism `mail_sync_worker.py` relies on to recognize "this Sent-Items
   message is one BlissWork already knows about" instead of re-importing a
   member's own outgoing mail as a fake inbound copy: the caller backfills
   `mail_messages.external_message_id` with the Graph-assigned
   `internetMessageId`, and the existing dedup unique index on that column does
   the rest. `internetMessageId` is only settable/known while the message is a
   draft — Graph freezes it the moment the message is sent — so this has to
   happen in this order.
"""
from __future__ import annotations

import base64
import hmac
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from resilience import CircuitBreaker, retry_async

from . import httpclient

_GRAPH = "https://graph.microsoft.com/v1.0"
_TIMEOUT = 15.0
_ms_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="microsoft")

#: Graph caps a mail subscription's lifetime and rejects anything longer (spec
#: says 4230 minutes / ~3 days). Requested slightly under the max so clock skew
#: between us and Graph can't push the request over the limit.
MAIL_SUBSCRIPTION_MINUTES = 4230 - 60

#: Renew this long before expiry. A lapsed subscription stops delivering
#: silently — there is no error, notifications simply stop — so the margin is
#: generous relative to mail_sync_worker's sweep interval.
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


class MicrosoftAmbiguousDelivery(MicrosoftError):
    """Graph may have accepted a non-idempotent send before returning an error."""


def _raise_for_status(r: httpx.Response, *, ambiguous_delivery: bool = False) -> None:
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
    has_retry_after = retry_after is not None
    delay: float | None = None
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            delay = None

    if ambiguous_delivery and (
        r.status_code == 504 or (r.status_code == 503 and not has_retry_after)
    ):
        raise MicrosoftAmbiguousDelivery(f"{r.status_code}: {msg}")

    # 503 with Retry-After and all 429 responses are explicit throttling.
    if r.status_code in (429, 503, 504):
        raise MicrosoftRateLimited(msg, delay)

    if r.status_code >= 500:
        # Let a plain httpx.HTTPStatusError propagate instead of MicrosoftError
        # so resilience.is_transient() recognizes it: retry_async actually
        # retries a transient 5xx, and CircuitBreaker.on_failure() fires instead
        # of on_success() falsely resetting the breaker mid-outage. Mirrors
        # providers/oauth.py's _raise_for_token_status.
        r.raise_for_status()

    raise MicrosoftError(f"{r.status_code}: {msg}")


async def _request(
    token: str,
    method: str,
    url: str,
    *,
    extra_headers: dict[str, str] | None = None,
    idempotent: bool = True,
    **kw,
) -> dict:
    """`url` may be absolute (a nextLink/deltaLink Graph handed us) or a path."""
    full = url if url.startswith("http") else f"{_GRAPH}{url}"
    headers = {"Authorization": f"Bearer {token}", **(extra_headers or {})}

    async def _attempt() -> dict:
        r = await httpclient.shared().request(method, full, headers=headers, timeout=_TIMEOUT, **kw)
        _raise_for_status(r, ambiguous_delivery=not idempotent)
        return r.json() if r.content else {}

    return await retry_async(_attempt, attempts=3, breaker=_ms_breaker, idempotent=idempotent)


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

    idempotent=False: a blind retry after a timeout would create a SECOND
    subscription for the same resource rather than confirming the first one —
    wasteful, not dangerous, but avoidable.
    """
    return await _request(
        token,
        "POST",
        "/subscriptions",
        json={
            "changeType": "created,updated,deleted",
            "notificationUrl": notification_url,
            "resource": resource,
            "expirationDateTime": subscription_expiry(minutes),
            "clientState": client_state,
        },
        idempotent=False,
    )


async def renew_subscription(token: str, subscription_id: str, *, minutes: int) -> dict:
    """Extend a subscription's expiry. Cheaper and less disruptive than
    recreating: the subscription id and clientState stay stable. Retrying this
    is safe — re-extending to the same expiry twice is a no-op."""
    return await _request(
        token,
        "PATCH",
        f"/subscriptions/{subscription_id}",
        json={"expirationDateTime": subscription_expiry(minutes)},
    )


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
    same pages next sweep is harmless; the mail dedup index absorbs it.

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


#: `$select` is not an optimization here: without it Graph returns the full
#: message including `body`, and the delta walk only needs the addressing/
#: state fields the worker decides on before fetching any one message in full.
_DELTA_SELECT = (
    "$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,"
    "internetMessageId,conversationId,webLink,isDraft,isRead"
)


def inbox_delta_url() -> str:
    """Starting delta URL for the mailbox Inbox — new/changed/removed mail
    arriving in this mailbox."""
    return f"/me/mailFolders('inbox')/messages/delta?{_DELTA_SELECT}"


def sentitems_delta_url() -> str:
    """Starting delta URL for Sent Items — mail sent directly from Outlook
    (never composed in BlissWork) and, for a mail BlissWork DID send, the copy
    Graph filed on our behalf. Walking this is what makes a reply typed
    straight into Outlook show up in BlissWork, not just new inbound mail."""
    return f"/me/mailFolders('sentitems')/messages/delta?{_DELTA_SELECT}"


async def get_message(token: str, message_id: str, *, as_text: bool = False) -> dict:
    """One mail in full, including the body the delta query deliberately omits.

    `as_text` asks Graph to convert the body to plain text rather than returning
    the HTML it was sent as. That conversion is worth having done by Microsoft:
    the alternative is an HTML-to-text pass of our own over untrusted markup,
    and the BlissWork inbox renders text, never a sender's HTML.
    """
    headers = {"Prefer": 'outlook.body-content-type="text"'} if as_text else None
    return await _request(token, "GET", f"/me/messages/{message_id}", extra_headers=headers)


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


async def set_message_read(token: str, message_id: str, is_read: bool) -> None:
    """Mark one message read/unread — the write-back half of read-state sync.

    Idempotent: setting isRead to a value it already holds is a no-op at Graph.
    """
    await _request(token, "PATCH", f"/me/messages/{message_id}", json={"isRead": is_read})


async def move_to_deleted(token: str, message_id: str) -> dict:
    """Move one message to Deleted Items — the write-back half of delete sync.

    A moved message gets a NEW id in the destination folder; the old id stops
    resolving. A caller retrying this after losing the response to a network
    fault will see a 404 (MicrosoftError referencing status 404) on the retry —
    that means "already moved", not a failure, and callers should treat it as
    success rather than surfacing it.
    """
    return await _request(token, "POST", f"/me/messages/{message_id}/move", json={"destinationId": "deleteditems"})


# ── sending ───────────────────────────────────────────────────────────────────
#: Total size of the attachment bytes Graph accepts inline on a message create
#: (POST /me/messages, same limit /sendMail had). The request itself is capped
#: at 4 MB and base64 inflates by a third, so this is the raw budget that fits
#: under it with room for the message. Anything larger needs an upload session
#: against the draft, which the caller does not have — it is told the mail
#: does not fit and relays that copy over SMTP instead.
MAX_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024


def _recipient_list(addresses: list[str] | None) -> list[dict]:
    return [{"emailAddress": {"address": a}} for a in (addresses or []) if a]


async def send_mail(
    token: str,
    *,
    to: str | list[str],
    subject: str,
    body: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    html: str = "",
    attachments: list[tuple[str, str, bytes]] | None = None,
    save_to_sent_items: bool = True,
) -> tuple[str, str]:
    """Send Outlook mail as the owner of `token`. Returns (graph_id, internet_message_id).

    DRAFT-THEN-SEND, not the simpler single-call `/me/sendMail`: a draft is
    created first (`POST /me/messages`, which returns the full message resource
    — its Graph `id` and Graph-assigned `internetMessageId`), and only then sent
    (`POST /me/messages/{id}/send`, which — like the old /sendMail — answers 202
    with an empty body). The caller backfills messaging-svc's
    `mail_messages.external_message_id` with the returned `internetMessageId`,
    which is what lets mail_sync_worker's Sent-Items delta walk recognize this
    exact message later and skip re-importing it as a fake inbound copy — see
    the module docstring. `/sendMail` cannot do this: it never materializes a
    message resource for the caller to read an id or internetMessageId off of.

    Everything past `body` exists for relaying a mail a member composed in
    BlissWork, and `bcc` is the one that carries a privacy obligation: Graph
    strips it from the headers every recipient sees, exactly as an MTA does, so
    a blind copy stays blind. The plain notification callers pass none of them
    and get byte-identical behaviour to before.

    Sending through the member's own mailbox — rather than through this
    deployment's SMTP relay — is what makes the mail genuinely theirs: the
    From: header is their real address because the mailbox IS theirs, their
    provider signs it with their domain's DKIM so it passes DMARC alignment
    instead of arriving unauthenticated, and `save_to_sent_items` files the copy
    in their Sent folder where they expect to find it. `save_to_sent_items`
    only affects the DRAFT's eventual disposition on send (Graph still accepts
    it on `/me/messages/{id}/send`): false is used for the extra copy that
    carries a Bcc, where the main send already filed the real Sent-folder row.

    Raises MicrosoftError when the attachments do not fit inline; see
    MAX_INLINE_ATTACHMENT_BYTES.
    """
    files = attachments or []
    total = sum(len(data) for _, _, data in files)
    if total > MAX_INLINE_ATTACHMENT_BYTES:
        raise MicrosoftError(
            f"attachments total {total} bytes, over the {MAX_INLINE_ATTACHMENT_BYTES} "
            "inline limit for a Graph message create"
        )

    message: dict = {
        "subject": subject,
        # HTML when the caller rendered it, plain text otherwise. Never both:
        # Graph takes ONE body, so offering it the text of an HTML mail would
        # send the recipient the version without the formatting.
        "body": {"contentType": "HTML" if html else "Text", "content": html or body},
        "toRecipients": _recipient_list([to] if isinstance(to, str) else to),
        "isDraft": True,
    }
    if cc:
        message["ccRecipients"] = _recipient_list(cc)
    if bcc:
        message["bccRecipients"] = _recipient_list(bcc)
    if files:
        message["attachments"] = [
            {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": name,
                "contentType": mime or "application/octet-stream",
                "contentBytes": base64.b64encode(data).decode("ascii"),
            }
            for name, mime, data in files
        ]

    # idempotent=False: creating a draft is a new object on every execution —
    # a ReadTimeout after Graph already created one must not be retried, or a
    # second draft is created and orphaned (never sent, but not nothing).
    draft = await _request(token, "POST", "/me/messages", json=message, idempotent=False)
    graph_id = str(draft.get("id") or "")
    internet_message_id = str(draft.get("internetMessageId") or "")

    # idempotent=False: sending is the one-way, non-idempotent step. A
    # ReadTimeout after Graph already accepted the send must not be retried —
    # the draft is gone (sent) and a retry would 404, which is a worse outcome
    # than the ambiguous-delivery path already handles explicitly.
    await _request(
        token,
        "POST",
        f"/me/messages/{graph_id}/send",
        json={},
        idempotent=False,
    )

    if not save_to_sent_items:
        # Unlike /sendMail, the send ACTION on a persisted draft has no flag to
        # suppress the Sent Items copy — Graph always files it. Best-effort
        # clean-up rather than part of the guaranteed contract: the mail is
        # already sent by this point, so a failure here is cosmetic (an unwanted
        # Sent-folder row), not a delivery failure, and must not raise. A 404
        # (already gone, or the id was reassigned on send) is equally benign.
        try:
            await _request(token, "DELETE", f"/me/messages/{graph_id}")
        except MicrosoftError:
            pass
    return graph_id, internet_message_id


async def send_chat_message(token: str, chat_id: str, text: str) -> dict:
    """Post to a Teams chat. Returns the created message (with its id)."""
    if not chat_id or chat_id in {".", ".."}:
        raise MicrosoftError("invalid Teams chat id")
    # idempotent=False: this creates a new chat message on every execution.
    return await _request(
        token,
        "POST",
        f"/chats/{quote(chat_id, safe='')}/messages",
        json={"body": {"contentType": "text", "content": text}},
        idempotent=False,
    )
