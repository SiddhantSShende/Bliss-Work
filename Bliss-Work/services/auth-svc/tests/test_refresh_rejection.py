"""A refused /auth/refresh must actually invalidate the client's cookie.

The bug this guards: the handler used to call `clear_refresh_cookie(response)`
and then RAISE HTTPException. Raising throws the mutated `response` away, so no
Set-Cookie was ever sent — the browser kept the revoked token and re-presented it
on every poll. One revoked family produced 26 identical 401s in eight minutes,
with the UI still looking signed in the whole time.

These are pure-logic checks against the real helper, no DB.
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
auth = pytest.importorskip(
    "app.routes.auth",
    reason="auth-svc deps not installed locally; CI installs requirements.txt.",
)
service = pytest.importorskip("app.service")


def _headers(resp) -> str:
    return resp.headers.get("set-cookie", "")


def test_terminal_rejection_clears_the_cookie() -> None:
    resp = auth._refresh_rejected("reused")
    assert resp.status_code == 401
    header = _headers(resp)
    # Deleting a cookie = re-setting it empty with an expiry in the past.
    assert "refresh_token=" in header
    assert "Path=/" in header
    assert "expires=" in header.lower() or "Max-Age=0" in header


def test_rejection_names_the_reason() -> None:
    # The client cannot tell "log the user out" from "retry later" without this.
    assert b'"code":"reused"' in auth._refresh_rejected("reused").body
    assert b'"code":"expired"' in auth._refresh_rejected("expired").body


def test_missing_token_does_not_clear_anything() -> None:
    # A request that simply arrived without the cookie is not evidence that the
    # session is dead, and must not nuke a perfectly good one.
    assert _headers(auth._refresh_rejected("missing", clear_cookie=False)) == ""


def test_refresh_error_carries_a_code_and_identity() -> None:
    err = service.RefreshError("reused", "refresh token reuse detected", user_id="u1", family_id="f1")
    assert err.code == "reused"
    assert (err.user_id, err.family_id) == ("u1", "f1")
    assert isinstance(err, ValueError)  # callers that still catch ValueError keep working


def test_replay_grace_window_is_short_but_nonzero() -> None:
    # Long enough to absorb a retried request or a dropped rotation response,
    # short enough that a stolen token is not broadly useful.
    assert 5 <= service.REFRESH_REPLAY_GRACE.total_seconds() <= 60
