"""Proves the CAPTCHA gate on /auth/login and /auth/orgs cannot be bypassed:
a missing or wrong CAPTCHA is rejected by the very first line of each
handler, before any identity lookup, password verify, or database
connection is ever opened. No Postgres needed here — that's the point: if
the gate were reachable-around, these tests would have to touch the DB to
prove it, and they don't.

Full success-path behavior (right credentials + right CAPTCHA -> a session;
right CAPTCHA + wrong credentials -> the existing 401) is verified live
against a running stack rather than here — this repo has no existing
harness for a real Postgres + real crypto/JWT-keys FastAPI app instance, and
building one is out of scope for adding CAPTCHA. Documented, not silently
skipped.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException, Response
from starlette.requests import Request

from app.routes import auth as auth_routes
from app.routes import captcha_service as cs
from app.schemas import CreateOrgRequest, LoginRequest


def _bare_request() -> Request:
    """A Request touching nothing but its own empty scope — sufficient
    because the CAPTCHA gate must reject before request_context(request) (or
    anything else) is ever reached."""
    return Request({"type": "http", "method": "POST", "path": "/auth/login", "headers": []})


class _EngineNeverTouched:
    """Stands in for app.db.engine: raises if ANY DB entry point is used,
    proving the CAPTCHA check runs — and rejects — before the handler gets
    anywhere near Postgres."""

    def begin(self):
        raise AssertionError("engine.begin() was called — CAPTCHA gate did not run first")

    def connect(self):
        raise AssertionError("engine.connect() was called — CAPTCHA gate did not run first")


@pytest.fixture(autouse=True)
def _no_db_access(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_routes, "engine", _EngineNeverTouched())


async def test_login_without_captcha_is_rejected_before_touching_the_db() -> None:
    body = LoginRequest(email="someone@example.com", password="whatever123!", captchaId=None, captchaValue=None)
    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.login(body, Response(), _bare_request())
    assert exc_info.value.status_code == 400


async def test_login_with_wrong_captcha_is_rejected_before_touching_the_db() -> None:
    captcha_id = cs.service.new_uuid()
    await cs._store.put(captcha_id, cs.service.sha256_bytes("AbCdEf12"), cs.settings.captcha_ttl_seconds)
    body = LoginRequest(
        email="someone@example.com",
        password="whatever123!",
        captchaId=captcha_id,
        captchaValue="totally-wrong",
    )
    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.login(body, Response(), _bare_request())
    assert exc_info.value.status_code == 400


async def test_login_with_valid_captcha_reaches_past_the_gate() -> None:
    """The gate must not reject a genuinely correct CAPTCHA — proven by
    letting the request proceed all the way to the (stubbed) engine, which is
    exactly the AssertionError this raises: reaching it means the CAPTCHA
    check passed and the next real step was an attempted DB call."""
    captcha_id = cs.service.new_uuid()
    await cs._store.put(captcha_id, cs.service.sha256_bytes("AbCdEf12"), cs.settings.captcha_ttl_seconds)
    body = LoginRequest(
        email="someone@example.com",
        password="whatever123!",
        captchaId=captcha_id,
        captchaValue="AbCdEf12",
    )
    with pytest.raises(AssertionError, match="engine.begin"):
        await auth_routes.login(body, Response(), _bare_request())


async def test_registration_without_captcha_is_rejected_before_touching_the_db() -> None:
    body = CreateOrgRequest(
        orgName="Acme",
        email="new@example.com",
        password="whatever123!",
        displayName="New Admin",
        captchaId=None,
        captchaValue=None,
    )
    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.create_org(body, Response())
    assert exc_info.value.status_code == 400


async def test_registration_with_wrong_captcha_is_rejected_before_touching_the_db() -> None:
    captcha_id = cs.service.new_uuid()
    await cs._store.put(captcha_id, cs.service.sha256_bytes("AbCdEf12"), cs.settings.captcha_ttl_seconds)
    body = CreateOrgRequest(
        orgName="Acme",
        email="new@example.com",
        password="whatever123!",
        displayName="New Admin",
        captchaId=captcha_id,
        captchaValue="nope",
    )
    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.create_org(body, Response())
    assert exc_info.value.status_code == 400


async def test_registration_with_valid_captcha_reaches_past_the_gate() -> None:
    captcha_id = cs.service.new_uuid()
    await cs._store.put(captcha_id, cs.service.sha256_bytes("AbCdEf12"), cs.settings.captcha_ttl_seconds)
    body = CreateOrgRequest(
        orgName="Acme",
        email="new@example.com",
        password="whatever123!",
        displayName="New Admin",
        captchaId=captcha_id,
        captchaValue="AbCdEf12",
    )
    with pytest.raises(AssertionError, match="engine.begin"):
        await auth_routes.create_org(body, Response())


async def test_captcha_is_still_enforced_even_with_a_correct_password_shaped_body() -> None:
    """A request that would otherwise be a perfectly plausible login must
    still be rejected on CAPTCHA alone — credentials being 'valid-looking'
    grants no exception to the gate."""
    body = LoginRequest(
        email="admin@example.com", password="CorrectHorseBattery9!", captchaId=None, captchaValue=None
    )
    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.login(body, Response(), _bare_request())
    assert exc_info.value.status_code == 400
