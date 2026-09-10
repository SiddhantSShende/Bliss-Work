"""POST /auth/orgs's existing-identity password check must enforce the same
account lockout /auth/login and /auth/invites/accept already do, against a
real Postgres.

── Why this cannot be a mock-only test ───────────────────────────────────────
The bug this file exists to catch was that create_org's existing-identity
branch never read identities.locked_until or called register_failed_login at
all — an attacker who knows a victim's email could guess passwords against
this endpoint with the account-level lockout never engaging, only the
per-IP/CAPTCHA layer standing between them and brute force. Proving the fix
means proving real rows in identities actually gate and record attempts, not
that some Python function got called — see
test_login_registration_captcha_gate.py's header for why this repo has no
existing full-app harness (real KMS/JWT keys) and this test does not attempt
to build one either: it stubs place_org (org-placement mechanics, unrelated
to what's under test) and points auth_routes.engine at a real migrated
Postgres, the same "real DB, direct function call" shape
tests/integration/test_audit_context.py already uses for app.service.

    TEST_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/authdb_scratch \\
        python -m pytest tests/integration/test_create_org_lockout.py -q
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import text

from app import service
from app.config import settings
from app.routes import auth as auth_routes
from app.routes import captcha_service as cs
from app.routing.placement import PlacementResult
from app.schemas import CreateOrgRequest
from app.security.passwords import hash_password_async
from crypto import cryptor, init_cryptor


@pytest.fixture(autouse=True)
def _init_crypto():
    # Normally done once at app startup (app/main.py); the dev KEK defaults
    # settings already carries are fine for a scratch test database.
    init_cryptor(settings)


async def _captcha(value: str = "AbCdEf12") -> str:
    captcha_id = cs.service.new_uuid()
    await cs._store.put(captcha_id, cs.service.sha256_bytes(value), cs.settings.captcha_ttl_seconds)
    return captcha_id


async def _fresh_captcha_body(email: str, password: str) -> CreateOrgRequest:
    return CreateOrgRequest(
        orgName="Acme " + uuid.uuid4().hex[:8],
        email=email,
        password=password,
        displayName="New Admin",
        captchaId=await _captcha(),
        captchaValue="AbCdEf12",
    )


async def _stub_place_org(conn, org_id, **_kwargs):
    return PlacementResult(site=settings.site_id, reason="only-candidate", alerts=())


@pytest.fixture(autouse=True)
def _stub_placement(monkeypatch: pytest.MonkeyPatch):
    # Org-placement mechanics are unrelated to what this file tests, and
    # exercising them for real needs seeded site-capacity rows this test has
    # no reason to set up.
    monkeypatch.setattr(auth_routes, "place_org", _stub_place_org)


@pytest.fixture
async def real_engine(monkeypatch: pytest.MonkeyPatch, sa_engine):
    """Points auth_routes.engine (module-level, used directly by create_org)
    at the real migrated test database instead of the app's normal one.

    Also patches service.engine: the existing-identity lockout write happens
    in a SEPARATE transaction inside service.resolve_or_create_identity (so it
    survives the caller's transaction aborting on a wrong password), and that
    function pulls its own `engine` from app.service rather than from
    whichever route called it.
    """
    monkeypatch.setattr(auth_routes, "engine", sa_engine)
    monkeypatch.setattr(service, "engine", sa_engine)
    return sa_engine


async def _seed_identity(sa_engine, email: str, password: str) -> str:
    identity_id = str(uuid.uuid4())
    c = cryptor()
    email_bidx = c.blind_index(email)
    ph = await hash_password_async(password)
    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "INSERT INTO identities (id, email_bidx, password_hash, email_verified) "
                "VALUES (:id, :b, :ph, true)"
            ),
            {"id": identity_id, "b": email_bidx, "ph": ph},
        )
    return identity_id


async def _identity_state(sa_engine, identity_id: str):
    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        row = (
            await conn.execute(
                text("SELECT failed_login_count, locked_until FROM identities WHERE id = :id"),
                {"id": identity_id},
            )
        ).first()
    return row


# ── The bug: repeated wrong passwords against an existing identity must lock it,
# exactly like /auth/login ────────────────────────────────────────────────────
async def test_repeated_wrong_password_locks_the_identity(real_engine):
    email = f"victim-{uuid.uuid4().hex[:8]}@example.com"
    identity_id = await _seed_identity(real_engine, email, "Correct-Horse-9-Battery!")

    for attempt in range(settings.login_max_failed_attempts - 1):
        with pytest.raises(HTTPException) as exc_info:
            await auth_routes.create_org(
                await _fresh_captcha_body(email, "Wr0ng-Password!"), Response()
            )
        assert exc_info.value.status_code == 409, f"attempt {attempt}: want 409 (not yet locked)"

    # The attempt that crosses the threshold.
    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.create_org(await _fresh_captcha_body(email, "Wr0ng-Password!"), Response())
    assert exc_info.value.status_code == 429
    assert "Retry-After" in exc_info.value.headers

    row = await _identity_state(real_engine, identity_id)
    assert row.locked_until is not None, "identity was not locked after crossing the failed-attempt threshold"


# ── Once locked, even the CORRECT password is refused — same as /auth/login ──
async def test_locked_identity_refuses_even_the_correct_password(real_engine):
    email = f"victim-{uuid.uuid4().hex[:8]}@example.com"
    correct_password = "Correct-Horse-9-Battery!"
    await _seed_identity(real_engine, email, correct_password)

    for _ in range(settings.login_max_failed_attempts):
        with pytest.raises(HTTPException):
            await auth_routes.create_org(await _fresh_captcha_body(email, "Wr0ng-Password!"), Response())

    with pytest.raises(HTTPException) as exc_info:
        await auth_routes.create_org(await _fresh_captcha_body(email, correct_password), Response())
    assert exc_info.value.status_code == 429, (
        "a locked identity must refuse the CORRECT password too — reaching org "
        "creation at all here means the lockout was bypassed"
    )
