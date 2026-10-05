"""A correct password that still owes a second factor must NOT clear the failed-attempt count.

── Why this needs a database ─────────────────────────────────────────────────
`/auth/login` reset the identity's lockout the moment the password matched, before
it knew whether the sign-in was finished. When the membership must also pass MFA
the reset still ran, so an attacker holding the password could guess second-factor
codes, log in again with the password (counter back to zero), and guess again: the
lockout that `mfa_challenge` documents as protecting the second factor never
accumulated. The reset belongs to the sign-in that actually completes.

Same shape as test_refresh_reuse.py: the route function is called directly, with the
module's `engine` pointed at the migrated test database.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from starlette.requests import Request
from starlette.responses import Response

from app import service
from app.config import settings
from app.routes import auth as auth_routes
from app.schemas import LoginRequest, MfaPendingDTO
from app.security.passwords import hash_password_async
from crypto import cryptor, init_cryptor

pytestmark = pytest.mark.integration

PASSWORD = "Correct-Horse-9-Battery!"
PRIOR_FAILURES = 3


@pytest.fixture(autouse=True)
def _init_crypto():
    init_cryptor(settings)


@pytest.fixture
async def real_engine(monkeypatch: pytest.MonkeyPatch, sa_engine):
    monkeypatch.setattr(auth_routes, "engine", sa_engine)
    monkeypatch.setattr(service, "engine", sa_engine)

    async def _no_captcha(*_a, **_k):
        return None

    monkeypatch.setattr(auth_routes.captcha_service, "verify_and_consume", _no_captcha)
    # Signing needs the deployed Ed25519 key file, which a scratch test has no use for.
    monkeypatch.setattr(service, "mint_access_token", lambda *_a, **_k: ("test-access-token", 300))
    return sa_engine


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 1)})


async def _identity_with_failures(engine, *, requires_mfa: bool) -> tuple[str, str]:
    """(email, identity_id): one org admin who has already failed PRIOR_FAILURES logins."""
    email = f"admin-{uuid.uuid4().hex[:8]}@example.com"
    org_id, user_id, identity_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text(
                "INSERT INTO identities (id, email_bidx, password_hash, email_verified, failed_login_count) "
                "VALUES (:id, :b, :ph, true, :n)"
            ),
            {
                "id": identity_id,
                "b": cryptor().blind_index(email),
                "ph": await hash_password_async(PASSWORD),
                "n": PRIOR_FAILURES,
            },
        )
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, 'Test Org', :slug)"),
            {"id": org_id, "slug": f"test-{org_id}"},
        )
        if requires_mfa:
            await conn.execute(
                text(
                    "UPDATE orgs SET require_mfa_for_admins = true, "
                    "mfa_grace_period_ends_at = now() - interval '1 hour' WHERE id = :id"
                ),
                {"id": org_id},
            )
        await conn.execute(
            text(
                "INSERT INTO users (id, org_id, identity_id, username, password_hash) "
                "VALUES (:id, :org, :iid, :un, 'x')"
            ),
            {"id": user_id, "org": org_id, "iid": identity_id, "un": f"user-{user_id[:8]}"},
        )
        role_id = (await conn.execute(text("SELECT id FROM roles WHERE name = 'org_admin'"))).scalar()
        await conn.execute(
            text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
            {"u": user_id, "r": role_id, "o": org_id},
        )
    return email, identity_id


async def _failed_count(engine, identity_id: str) -> int:
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return (
            await conn.execute(text("SELECT failed_login_count FROM identities WHERE id = :id"), {"id": identity_id})
        ).scalar_one()


async def _login(email: str):
    return await auth_routes.login(LoginRequest(email=email, password=PASSWORD), Response(), _request())


async def test_a_password_that_still_owes_a_second_factor_keeps_the_failed_count(real_engine):
    email, identity_id = await _identity_with_failures(real_engine, requires_mfa=True)

    result = await _login(email)

    assert isinstance(result, MfaPendingDTO)
    assert await _failed_count(real_engine, identity_id) == PRIOR_FAILURES


async def test_a_completed_sign_in_still_clears_the_failed_count(real_engine):
    email, identity_id = await _identity_with_failures(real_engine, requires_mfa=False)

    await _login(email)

    assert await _failed_count(real_engine, identity_id) == 0
