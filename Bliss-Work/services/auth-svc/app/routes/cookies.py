"""Refresh-token cookie helpers."""
from __future__ import annotations

from fastapi import Response

from ..config import settings

# Cookie Path MUST be "/" — not "/auth". In production the SPA reaches auth-svc
# through the edge proxy at a *public* path of /api/auth/* (Caddy `handle_path`
# strips the /api/auth prefix upstream but does NOT rewrite the Set-Cookie Path).
# A cookie scoped to "/auth" is therefore never sent back on /api/auth/refresh,
# so the silent refresh on page reload 401s and the user is logged out. Scoping
# to "/" makes the httpOnly refresh cookie travel on every same-origin request
# (prod behind /api/auth, and local/desktop dev hitting /auth directly). The
# cookie stays HttpOnly + Secure + SameSite, so widening the path is not a
# meaningful exposure — only the /auth/refresh handler ever reads it.
REFRESH_COOKIE = "refresh_token"
COOKIE_PATH = "/"


def set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=raw_token,
        max_age=settings.jwt_refresh_ttl_seconds,
        httponly=True,
        samesite=settings.cookie_samesite,  # "lax" (default) / "strict" / "none"
        path=COOKIE_PATH,
        secure=settings.cookie_secure,  # env-driven: MUST be True behind TLS in prod
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=REFRESH_COOKIE, path=COOKIE_PATH)
