"""Microsoft Graph adapter — Teams chat.

Shape mirrors slack.py/gmail.py: module timeout, one CircuitBreaker, every call
through retry_async, three error classes that route to different recovery
paths.

  MicrosoftAuthError (401)  — token expired. NOT a broken connection: the caller
                              enrolls it for the existing refresh_worker sweep.
  MicrosoftRateLimited(429) — Graph is aggressive about throttling and almost
                              always supplies Retry-After. Honor it.
  MicrosoftError            — definitive.
"""
from __future__ import annotations

from urllib.parse import quote

import httpx

from resilience import CircuitBreaker, retry_async

from . import httpclient

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
