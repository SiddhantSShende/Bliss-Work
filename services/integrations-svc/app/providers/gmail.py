"""Gmail adapter (Google Workspace / consumer Gmail via the Gmail REST API).

Shape mirrors slack.py: module-level timeout, one CircuitBreaker, every network
call through retry_async, and error types that distinguish the three cases
callers must handle differently.

  GmailAuthError (401)  — the access token expired. NOT a broken connection:
                          the caller sets token_expires_at = now() so the
                          existing refresh_worker picks it up on its next sweep.
  GmailRateLimited(429) — honor Retry-After; back off, do not drop the work.
  GmailError            — definitive (bad request, revoked scope). Do not retry.

Auth is per-connection OAuth (see providers/oauth.py); this module never sees
the org's client credentials, only the resolved access token.

INGEST NOTE: `get_message` fetches format=metadata with an explicit header
allowlist. Mention detection needs To/Cc/From plus the bulk-mail markers, and
nothing else — pulling `format=full` would drag the entire message body and
every attachment through this service for no benefit, and put more PII in
flight than we store.
"""
from __future__ import annotations

import base64
from email.message import EmailMessage
from email.utils import formataddr

import httpx

from ..resilience import CircuitBreaker, retry_async

_GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
_TIMEOUT = 15.0
_gmail_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="gmail")

#: Headers `mentions.detect_mentions` actually reads. Keep in sync with
#: mentions._mail_scan — an omission here silently disables a filter, which
#: shows up as newsletters appearing in someone's mention feed.
METADATA_HEADERS = (
    "From",
    "To",
    "Cc",
    "Subject",
    "Date",
    "Message-Id",
    "List-Id",
    "List-Unsubscribe",
    "Precedence",
    "Auto-Submitted",
)


class GmailError(Exception):
    """A definitive Gmail API failure — retrying will not help."""


class GmailAuthError(GmailError):
    """401: the access token is expired or revoked. Enroll for refresh."""


class GmailRateLimited(GmailError):
    """429/quota: back off. `retry_after` is seconds, when the API supplied one."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _raise_for_status(r: httpx.Response) -> None:
    """Map an error response onto our three cases.

    Google reports quota exhaustion as 403 with a `reason` of rateLimitExceeded
    / userRateLimitExceeded, NOT as 429 — treating that as definitive would drop
    the work permanently instead of retrying it a moment later.
    """
    if r.status_code < 400:
        return

    try:
        body = r.json()
        err = body.get("error", {}) if isinstance(body, dict) else {}
        msg = err.get("message") or r.text
        reasons = {d.get("reason", "") for d in (err.get("errors") or [])}
    except ValueError:
        msg, reasons = r.text, set()

    if r.status_code == 401:
        raise GmailAuthError(msg)

    retry_after = r.headers.get("Retry-After")
    delay = float(retry_after) if retry_after and retry_after.isdigit() else None
    if r.status_code == 429:
        raise GmailRateLimited(msg, delay)
    if r.status_code == 403 and reasons & {
        "rateLimitExceeded",
        "userRateLimitExceeded",
        "quotaExceeded",
    }:
        raise GmailRateLimited(msg, delay)

    raise GmailError(f"{r.status_code}: {msg}")


async def _request(token: str, method: str, path: str, **kw) -> dict:
    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.request(
                method,
                f"{_GMAIL_API}{path}",
                headers={"Authorization": f"Bearer {token}"},
                **kw,
            )
            _raise_for_status(r)
            return r.json() if r.content else {}

    return await retry_async(_attempt, attempts=3, breaker=_gmail_breaker)


# ── identity ──────────────────────────────────────────────────────────────────
async def profile(token: str) -> dict:
    """The mailbox's own profile — emailAddress plus the current historyId.

    That historyId is the ingest starting point: it means "everything from here
    on", so a freshly connected mailbox does not replay its entire history into
    the mention feed.
    """
    return await _request(token, "GET", "/users/me/profile")


# ── push subscription ─────────────────────────────────────────────────────────
async def watch(token: str, topic: str, *, label_ids: list[str] | None = None) -> dict:
    """Start (or renew) a push subscription to the org's own Pub/Sub topic.

    Returns {historyId, expiration}. Watches expire after 7 days, so the worker
    re-arms well before that. Calling watch again on an active mailbox is the
    documented renewal path — it is not an error.

    Scoped to INBOX by default: without a label filter Google notifies on every
    mailbox change including sent mail and label edits, which is a lot of push
    traffic to discard.
    """
    return await _request(
        token,
        "POST",
        "/users/me/watch",
        json={
            "topicName": topic,
            "labelIds": label_ids or ["INBOX"],
            "labelFilterBehavior": "INCLUDE",
        },
    )


async def stop(token: str) -> None:
    """Cancel the push subscription. Called on disconnect so Google stops
    publishing to a topic nobody is reading."""
    await _request(token, "POST", "/users/me/stop")


# ── reading ───────────────────────────────────────────────────────────────────
async def history_list(
    token: str, start_history_id: str, *, page_token: str | None = None
) -> dict:
    """Changes since `start_history_id`, restricted to newly-added messages.

    A 404 here means the history id is too old to serve (Google keeps roughly a
    week). Callers must treat that as "re-baseline from profile().historyId"
    rather than an error — the alternative is a connection that never ingests
    again after a long outage.
    """
    params: dict[str, str] = {
        "startHistoryId": start_history_id,
        "historyTypes": "messageAdded",
        "labelId": "INBOX",
    }
    if page_token:
        params["pageToken"] = page_token
    return await _request(token, "GET", "/users/me/history", params=params)


async def get_message(token: str, message_id: str) -> dict:
    """Fetch one message's metadata — headers only, never the body.

    See the module docstring: mention detection needs the addressing headers and
    the bulk-mail markers, and pulling the full body would move more PII through
    this service than it stores.
    """
    params = [("format", "metadata")] + [("metadataHeaders", h) for h in METADATA_HEADERS]
    return await _request(token, "GET", f"/users/me/messages/{message_id}", params=params)


# ── sending ───────────────────────────────────────────────────────────────────
def build_mime(
    *, to: str, subject: str, body: str, from_addr: str = "", from_name: str = ""
) -> str:
    """Build an RFC-2822 message, base64url-encoded WITHOUT padding.

    The padding detail is not cosmetic: Gmail's `raw` field is base64url and
    Google rejects a padded value. `urlsafe_b64encode` always pads, so the
    `=` stripping below is required, and it is the kind of thing that works in
    every manual test with a body length that happens to be a multiple of 3.
    """
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    if from_addr:
        msg["From"] = formataddr((from_name, from_addr)) if from_name else from_addr
    msg.set_content(body)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii").rstrip("=")


async def send_message(token: str, raw: str, *, thread_id: str | None = None) -> dict:
    """Send a message built by `build_mime`. Returns {id, threadId, labelIds}.

    `thread_id` keeps a reply in its original conversation; Gmail also requires
    the In-Reply-To/References headers for correct threading in other clients,
    so callers replying to a known message should set both.
    """
    payload: dict[str, str] = {"raw": raw}
    if thread_id:
        payload["threadId"] = thread_id
    return await _request(token, "POST", "/users/me/messages/send", json=payload)


# ── helpers ───────────────────────────────────────────────────────────────────
def headers_of(message: dict) -> dict[str, str]:
    """Flatten a Gmail message's header list into a case-insensitive-ish dict.

    Gmail returns `payload.headers` as [{name, value}, …] with inconsistent
    casing between accounts, so keys are lowercased. Duplicate headers keep the
    FIRST occurrence, matching how a mail client resolves them.
    """
    out: dict[str, str] = {}
    for h in (message.get("payload", {}) or {}).get("headers", []) or []:
        name = str(h.get("name", "")).lower()
        if name and name not in out:
            out[name] = str(h.get("value", ""))
    return out


def message_ids_from_history(history: dict) -> list[str]:
    """Every newly-added message id in a history page, de-duplicated in order.

    One history record can list the same message under several changes, and a
    page can repeat ids across records — the dedup here just avoids redundant
    get_message calls. It is NOT the idempotency guard: that remains the
    (connection_id, external_id_bidx) unique index in ingest_one.
    """
    seen: set[str] = set()
    ids: list[str] = []
    for record in history.get("history", []) or []:
        for added in record.get("messagesAdded", []) or []:
            mid = str((added.get("message") or {}).get("id") or "")
            if mid and mid not in seen:
                seen.add(mid)
                ids.append(mid)
    return ids
