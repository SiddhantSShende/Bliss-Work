"""The passkey `start` endpoints must COMMIT the challenge they hand out, against
a real Postgres.

── Why this cannot be a mock-only test ───────────────────────────────────────
Each `start` route minted its single-use challenge through `mint_token` on a
connection from `engine.connect()`. SQLAlchemy 2.x does not autocommit, so leaving
that block rolled the INSERT back: the browser received a challenge no row backed,
and the matching `finish` step could never redeem it. Every passkey enrolment,
login and step-up failed, and the existing MFA tests missed it because they mint
on one long-lived connection and never leave a transaction. Only a second,
independent transaction shows whether the row survived.

Same shape as test_refresh_reuse.py: the route function is called directly, with
the module's `engine` pointed at the migrated test database.
"""
from __future__ import annotations

import base64
import uuid

import pytest
from sqlalchemy import text

from app import service
from app.config import settings
from app.routes import mfa_service, mfa_webauthn
from app.schemas import WebauthnAuthStartRequest, WebauthnRegisterStartRequest
from crypto import init_cryptor

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _init_crypto():
    # Enrolment start builds the user's DTO, which decrypts; normally done once at app startup.
    init_cryptor(settings)


@pytest.fixture
async def real_engine(monkeypatch: pytest.MonkeyPatch, sa_engine):
    monkeypatch.setattr(mfa_webauthn, "engine", sa_engine)
    monkeypatch.setattr(service, "engine", sa_engine)
    return sa_engine


async def _user_with_a_passkey(engine) -> tuple[str, str]:
    org_id, user_id = str(uuid.uuid4()), str(uuid.uuid4())
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, 'Test Org', :slug)"),
            {"id": org_id, "slug": f"test-{org_id}"},
        )
        await conn.execute(
            text("INSERT INTO users (id, org_id, username, password_hash) VALUES (:id, :org, :un, 'x')"),
            {"id": user_id, "org": org_id, "un": f"user-{user_id[:8]}"},
        )
        await conn.execute(
            text(
                "INSERT INTO mfa_webauthn_credentials (id, user_id, org_id, credential_id, public_key, sign_count) "
                "VALUES (:id, :uid, :org, :cid, :pk, 0)"
            ),
            {"id": str(uuid.uuid4()), "uid": user_id, "org": org_id, "cid": uuid.uuid4().bytes, "pk": b"pk"},
        )
    return org_id, user_id


def _challenge_of(options: dict) -> bytes:
    encoded = options["challenge"]
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


async def _redeem_in_a_new_transaction(engine, challenge: bytes) -> tuple[str, str]:
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return await mfa_service.consume_webauthn_challenge(conn, challenge)


async def test_login_time_start_hands_out_a_challenge_the_finish_step_can_redeem(real_engine):
    org_id, user_id = await _user_with_a_passkey(real_engine)
    async with real_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        pending = await mfa_service.mint_mfa_pending(conn, org_id, user_id)

    options = await mfa_webauthn.auth_start(WebauthnAuthStartRequest(pendingToken=pending))

    assert await _redeem_in_a_new_transaction(real_engine, _challenge_of(options)) == (user_id, org_id)


async def test_step_up_start_hands_out_a_challenge_the_finish_step_can_redeem(real_engine):
    from app.security.auth_dep import Principal

    org_id, user_id = await _user_with_a_passkey(real_engine)
    principal = Principal(user_id=user_id, org_id=org_id, roles=["member"], username="u")

    options = await mfa_webauthn.step_up_start(principal=principal)

    assert await _redeem_in_a_new_transaction(real_engine, _challenge_of(options)) == (user_id, org_id)


async def test_enrolment_start_hands_out_a_challenge_the_finish_step_can_redeem(real_engine):
    org_id, user_id = await _user_with_a_passkey(real_engine)
    async with real_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        pending = await mfa_service.mint_mfa_pending(conn, org_id, user_id)

    options = await mfa_webauthn.register_start(WebauthnRegisterStartRequest(pendingToken=pending), authorization=None)

    assert await _redeem_in_a_new_transaction(real_engine, _challenge_of(options)) == (user_id, org_id)
