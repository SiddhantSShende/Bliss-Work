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
"""
from __future__ import annotations

import base64

import httpx

from ..resilience import CircuitBreaker, retry_async

_GRAPH = "https://graph.microsoft.com/v1.0"
_TIMEOUT = 15.0
_ms_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="microsoft")


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


# ── sending ───────────────────────────────────────────────────────────────────
#: Total size of the attachment bytes Graph accepts inline on /sendMail. The
#: request itself is capped at 4 MB and base64 inflates by a third, so this is
#: the raw budget that fits under it with room for the message. Anything larger
#: needs an upload session against a draft, which the caller does not have —
#: it is told the mail does not fit and relays that copy over SMTP instead.
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
) -> None:
    """Send Outlook mail as the owner of `token`.

    Graph answers 202 with an EMPTY body — there is no message id to return.
    Callers must therefore write the activity mirror with external_id = None,
    which the partial unique index on external_id_bidx tolerates (it only covers
    non-null values).

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
    in their Sent folder where they expect to find it.

    Raises MicrosoftError when the attachments do not fit inline; see
    MAX_INLINE_ATTACHMENT_BYTES.
    """
    files = attachments or []
    total = sum(len(data) for _, _, data in files)
    if total > MAX_INLINE_ATTACHMENT_BYTES:
        raise MicrosoftError(
            f"attachments total {total} bytes, over the {MAX_INLINE_ATTACHMENT_BYTES} "
            "inline limit for /sendMail"
        )

    message: dict = {
        "subject": subject,
        # HTML when the caller rendered it, plain text otherwise. Never both:
        # Graph takes ONE body, so offering it the text of an HTML mail would
        # send the recipient the version without the formatting.
        "body": {"contentType": "HTML" if html else "Text", "content": html or body},
        "toRecipients": _recipient_list([to] if isinstance(to, str) else to),
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

    await _request(
        token,
        "POST",
        "/me/sendMail",
        json={"message": message, "saveToSentItems": save_to_sent_items},
    )


async def send_chat_message(token: str, chat_id: str, text: str) -> dict:
    """Post to a Teams chat. Returns the created message (with its id)."""
    return await _request(
        token,
        "POST",
        f"/chats/{chat_id}/messages",
        json={"body": {"contentType": "text", "content": text}},
    )
