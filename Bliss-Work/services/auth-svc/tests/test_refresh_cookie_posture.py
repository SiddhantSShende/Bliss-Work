"""The refresh cookie's SameSite posture is load-bearing — pin it.

The desktop app cannot use this cookie at all: a packaged Electron build serves
its renderer from file://, which makes every request to the API origin
cross-site, and Chromium will not attach a SameSite=lax cookie to a cross-site
fetch. The obvious "fix" is to set COOKIE_SAMESITE=none. That would be a
significant security regression and these tests exist to stop it.

Why it is not safe here: set_refresh_cookie is shared by login, refresh, logout,
org-switch and invite-accept, so relaxing it drops the CSRF backstop for every
browser user at once. And security/origin.py deliberately treats ``Origin: null``
as allowed — which is exactly what a browser sends from a sandboxed attacker
iframe. Under SameSite=none a forged /auth/refresh would rotate a victim's token;
their real tab's next refresh would then look like token reuse, tripping
revoke_family_by_token and logging them out. SameSite=lax is the only thing
currently preventing that request from carrying the cookie.

The desktop instead sends the refresh token in the request body, which
/auth/refresh already accepts — see apps/desktop/src/main/session-token.ts and
packages/app/src/lib/refresh.ts.
"""
from __future__ import annotations

import pytest
from fastapi import Response

from app.config import settings
from app.routes.cookies import REFRESH_COOKIE, set_refresh_cookie


def _cookie_header(response: Response) -> str:
    raw = response.raw_headers
    for key, value in raw:
        if key.decode().lower() == "set-cookie":
            return value.decode()
    raise AssertionError("no Set-Cookie header was emitted")


def test_refresh_cookie_is_samesite_lax_and_httponly() -> None:
    """Lax + HttpOnly is the posture web clients depend on."""
    response = Response()
    set_refresh_cookie(response, "a-refresh-token")
    header = _cookie_header(response)

    assert f"{REFRESH_COOKIE}=" in header
    assert "HttpOnly" in header
    assert "SameSite=lax" in header.replace("samesite", "SameSite"), (
        "The refresh cookie must stay SameSite=lax. If you are changing this to "
        "make the DESKTOP app work: don't — the desktop sends the token in the "
        "/auth/refresh body instead. See the module docstring."
    )


def test_samesite_none_is_not_the_configured_default() -> None:
    """Guard the config value itself, not just one call's output."""
    assert settings.cookie_samesite.lower() != "none", (
        "COOKIE_SAMESITE=none removes the CSRF backstop for every browser user, "
        "and origin.py intentionally allows Origin: null (sandboxed iframes). "
        "Harden origin.py first if this ever genuinely needs to change."
    )


@pytest.mark.parametrize("value", ["lax", "strict"])
def test_supported_samesite_values_round_trip(value: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """strict is a valid tightening; none is the only value we refuse."""
    monkeypatch.setattr(settings, "cookie_samesite", value)
    response = Response()
    set_refresh_cookie(response, "t")
    assert f"samesite={value}" in _cookie_header(response).lower()
