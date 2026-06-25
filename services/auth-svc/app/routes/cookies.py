"""Refresh-token cookie helpers."""
from __future__ import annotations

from fastapi import Response

from ..config import settings

REFRESH_COOKIE = "refresh_token"
COOKIE_PATH = "/auth"


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
