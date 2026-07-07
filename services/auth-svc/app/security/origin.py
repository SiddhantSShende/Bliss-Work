"""CSRF defence-in-depth: reject browser requests whose Origin/Referer doesn't
match the configured web origin.

The refresh cookie is HttpOnly + (prod) Secure + SameSite, which already blocks
the classic cross-site cookie-replay CSRF. This is belt-and-suspenders for the
state-changing, cookie-bearing endpoints (/auth/login, /auth/refresh,
/auth/logout, /auth/orgs, /auth/invites/accept): a forged cross-site POST that
carries an attacker Origin is rejected with 403 BEFORE the handler runs.

Allowlist mirrors the CORS policy in main.py (web_origin + localhost/Electron):
  * a request with NO Origin AND NO Referer is ALLOWED — native/desktop/CLI and
    server-to-server clients legitimately send neither; only a *present* origin
    is checked. (CSRF requires a browser, which always sends Origin on a
    cross-site state-changing request.)
  * Origin "null" (sandboxed/file:// first-party Electron) is allowed.
  * a PRESENT origin that is neither web_origin nor a localhost/app/file origin
    is rejected.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, status

from ..config import settings

# Same shape as main.py's CORS allow_origin_regex (localhost / loopback / Electron).
_LOCAL_RE = re.compile(r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|app://.*|file://.*)$")


def _host(url: str) -> str | None:
    try:
        netloc = urlsplit(url).netloc.lower()
    except ValueError:
        return None
    return netloc or None


def _is_allowed(value: str) -> bool:
    v = value.strip()
    if not v or v.lower() == "null":
        return True
    if _LOCAL_RE.match(v):
        return True
    host = _host(v)
    return host is not None and host == _host(settings.web_origin)


def request_is_same_origin(origin: str | None, referer: str | None) -> bool:
    """Pure predicate (unit-testable). Origin takes precedence over Referer; a
    request with neither is treated as same-origin (non-browser client)."""
    candidate = origin if origin is not None else referer
    if not candidate:
        return True
    return _is_allowed(candidate)


async def enforce_origin(request: Request) -> None:
    """FastAPI dependency: 403 when a present Origin/Referer is cross-site."""
    if not request_is_same_origin(
        request.headers.get("origin"), request.headers.get("referer")
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "cross-origin request rejected")
