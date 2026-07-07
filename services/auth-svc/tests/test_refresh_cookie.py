"""Refresh-cookie attributes contract.

Regression guard for the page-reload logout bug: the refresh cookie MUST be
scoped to Path="/" — NOT "/auth". In production the SPA reaches auth-svc through
the edge proxy at the public path /api/auth/* (Caddy strips the /api/auth prefix
upstream but does not rewrite the Set-Cookie Path). A cookie scoped to "/auth" is
never sent back to /api/auth/refresh, so the silent refresh on reload 401s and
the user is logged out. These are pure-logic checks against the real helper.
"""
from __future__ import annotations

import pytest

cookies = pytest.importorskip(
    "app.routes.cookies",
    reason="auth-svc deps not installed locally; CI installs requirements.txt.",
)
pytest.importorskip("fastapi")
from fastapi import Response  # noqa: E402


def _set_cookie_header() -> str:
    resp = Response()
    cookies.set_refresh_cookie(resp, "raw-token-value")
    return resp.headers["set-cookie"]


def test_cookie_path_is_root_not_auth() -> None:
    assert cookies.COOKIE_PATH == "/"
    header = _set_cookie_header()
    assert "Path=/" in header
    # Must NOT be the narrow /auth scope that broke reload refresh.
    assert "Path=/auth" not in header


def test_cookie_is_httponly() -> None:
    assert "HttpOnly" in _set_cookie_header()


def test_clear_uses_same_root_path() -> None:
    resp = Response()
    cookies.clear_refresh_cookie(resp)
    header = resp.headers["set-cookie"]
    assert "Path=/" in header
    assert "Path=/auth" not in header
