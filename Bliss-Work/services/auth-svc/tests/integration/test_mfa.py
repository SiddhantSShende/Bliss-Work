"""MFA (Phase 7) against a REAL Postgres — the properties that only mean
anything under real row locking and real RLS:

  * TOTP replay-safety is atomic: two concurrent requests replaying the same
    captured code cannot both pass (the FOR UPDATE lock actually serializes
    them, not just "usually works").
  * The mandatory-admin gate: grace period, per-membership scoping, and the
    non-admin/enrolled-already short-circuits.
  * Backup-code regeneration invalidates every prior unused code first.
  * The restricted enrollment credential's boundary: checkable any number of
    times without being spent, and refused once mfa_enrolled flips true.
Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import asyncio
import uuid

import pyotp
import pytest
from sqlalchemy import text

from app import service
from app.routes import mfa_service
from app.security.passwords import hash_password_async

pytestmark = pytest.mark.integration

STEP_UP_PASSWORD = "correct horse battery staple"


async def _seed_org_and_user(conn, *, role: str = "member") -> tuple[str, str]:
    org_id, user_id = str(uuid.uuid4()), str(uuid.uuid4())
    await service.set_bypass_rls(conn)
    await conn.execute(
        text("INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)"),
        {"id": org_id, "name": "Test Org", "slug": f"test-{org_id}"},
    )
    await conn.execute(
        text(
            "INSERT INTO users (id, org_id, username, password_hash) "
            "VALUES (:id, :org, :un, 'x')"
        ),
        {"id": user_id, "org": org_id, "un": f"user-{user_id[:8]}"},
    )
    role_id = (await conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": role})).scalar()
    await conn.execute(
        text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
        {"u": user_id, "r": role_id, "o": org_id},
    )
    return org_id, user_id


# ── TOTP replay-safety ────────────────────────────────────────────────────────
async def test_totp_replay_safe_rejects_reuse_of_the_same_code(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn)
    secret = pyotp.random_base32()
    code = pyotp.TOTP(secret).now()

    assert await mfa_service.verify_totp_replay_safe(sa_conn, user_id, secret, code) is True
    # The SAME code again — must fail even though it is still time-valid.
    assert await mfa_service.verify_totp_replay_safe(sa_conn, user_id, secret, code) is False


async def test_totp_replay_safe_serializes_a_concurrent_replay(pg_dsn):
    """The FOR UPDATE lock, proven rather than assumed: fire the SAME
    just-captured code at the SAME row from two connections at once. Exactly
    one must win — proving the lock genuinely serializes the two attempts,
    not merely that the logic is correct under a single caller."""
    from sqlalchemy.ext.asyncio import create_async_engine

    sa_dsn = pg_dsn.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(sa_dsn, pool_size=2)
    try:
        async with engine.connect() as seed_conn:
            await seed_conn.execute(text("SET ROLE rls_test"))
            org_id, user_id = await _seed_org_and_user(seed_conn)
            await seed_conn.commit()

        secret = pyotp.random_base32()
        code = pyotp.TOTP(secret).now()

        async def attempt() -> bool:
            async with engine.connect() as conn:
                # `SET ROLE` autobegins the connection's transaction; the
                # explicit commit below is what makes the WINNING attempt's
                # counter update visible (and its lock released) to whichever
                # attempt was blocked behind it.
                await conn.execute(text("SET ROLE rls_test"))
                await service.set_org_guc(conn, org_id)
                result = await mfa_service.verify_totp_replay_safe(conn, user_id, secret, code)
                await conn.commit()
                return result

        results = await asyncio.gather(attempt(), attempt())
        assert sorted(results) == [False, True]
    finally:
        await engine.dispose()


# ── mfa_gate: mandatory-admin policy, grace period, per-membership scope ──────
async def test_gate_is_off_when_no_policy_and_not_enrolled(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn, role="org_admin")
    required, must_enroll = await mfa_service.mfa_gate(sa_conn, user_id, org_id, ["org_admin"])
    assert (required, must_enroll) == (False, False)


async def test_gate_is_off_for_a_non_admin_even_with_the_policy_on(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn, role="member")
    await sa_conn.execute(
        text(
            "UPDATE orgs SET require_mfa_for_admins = true, "
            "mfa_grace_period_ends_at = now() - interval '1 day' WHERE id = :id"
        ),
        {"id": org_id},
    )
    required, must_enroll = await mfa_service.mfa_gate(sa_conn, user_id, org_id, ["member"])
    assert (required, must_enroll) == (False, False)


async def test_gate_is_a_banner_only_inside_the_grace_window(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn, role="org_admin")
    await sa_conn.execute(
        text(
            "UPDATE orgs SET require_mfa_for_admins = true, "
            "mfa_grace_period_ends_at = now() + interval '1 day' WHERE id = :id"
        ),
        {"id": org_id},
    )
    required, must_enroll = await mfa_service.mfa_gate(sa_conn, user_id, org_id, ["org_admin"])
    assert (required, must_enroll) == (False, False)


async def test_gate_blocks_and_requires_enrollment_once_grace_expires(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn, role="org_admin")
    await sa_conn.execute(
        text(
            "UPDATE orgs SET require_mfa_for_admins = true, "
            "mfa_grace_period_ends_at = now() - interval '1 hour' WHERE id = :id"
        ),
        {"id": org_id},
    )
    required, must_enroll = await mfa_service.mfa_gate(sa_conn, user_id, org_id, ["org_admin"])
    assert (required, must_enroll) == (True, True)


async def test_gate_requires_challenge_not_enrollment_once_actually_enrolled(sa_conn):
    """An enrolled admin past the deadline goes to challenge-verify, not back
    into enrollment."""
    org_id, user_id = await _seed_org_and_user(sa_conn, role="org_admin")
    await sa_conn.execute(
        text(
            "UPDATE orgs SET require_mfa_for_admins = true, "
            "mfa_grace_period_ends_at = now() - interval '1 hour' WHERE id = :id"
        ),
        {"id": org_id},
    )
    await sa_conn.execute(text("UPDATE users SET mfa_enrolled = true WHERE id = :id"), {"id": user_id})
    required, must_enroll = await mfa_service.mfa_gate(sa_conn, user_id, org_id, ["org_admin"])
    assert (required, must_enroll) == (True, False)


async def test_gate_applies_per_membership_not_across_the_identity(sa_conn):
    """The same person, enrolled and clear in org A, is still blocked entering
    org B if B mandates MFA past its deadline and this specific membership has
    never enrolled — MFA state does not carry across org boundaries."""
    org_a, user_a = await _seed_org_and_user(sa_conn, role="org_admin")
    await sa_conn.execute(text("UPDATE users SET mfa_enrolled = true WHERE id = :id"), {"id": user_a})
    required_a, _ = await mfa_service.mfa_gate(sa_conn, user_a, org_a, ["org_admin"])
    assert required_a is True  # enrolled -> always challenged, org policy irrelevant

    org_b, user_b = await _seed_org_and_user(sa_conn, role="org_admin")
    await sa_conn.execute(
        text(
            "UPDATE orgs SET require_mfa_for_admins = true, "
            "mfa_grace_period_ends_at = now() - interval '1 hour' WHERE id = :id"
        ),
        {"id": org_b},
    )
    required_b, must_enroll_b = await mfa_service.mfa_gate(sa_conn, user_b, org_b, ["org_admin"])
    assert (required_b, must_enroll_b) == (True, True)


# ── Backup codes ──────────────────────────────────────────────────────────────
async def test_regenerating_backup_codes_invalidates_every_prior_unused_code(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn)
    await service.set_org_guc(sa_conn, org_id)
    first_batch = mfa_service.generate_backup_codes()
    await mfa_service.store_backup_codes(sa_conn, org_id, user_id, first_batch)

    await mfa_service.invalidate_backup_codes(sa_conn, user_id)
    second_batch = mfa_service.generate_backup_codes()
    await mfa_service.store_backup_codes(sa_conn, org_id, user_id, second_batch)

    for code in first_batch:
        assert await mfa_service.verify_and_consume_backup_code(sa_conn, user_id, code) is False
    # The new batch is untouched by the invalidation that preceded its insert.
    assert await mfa_service.verify_and_consume_backup_code(sa_conn, user_id, second_batch[0]) is True


async def test_backup_code_is_single_use(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn)
    await service.set_org_guc(sa_conn, org_id)
    codes = mfa_service.generate_backup_codes()
    await mfa_service.store_backup_codes(sa_conn, org_id, user_id, codes)
    assert await mfa_service.verify_and_consume_backup_code(sa_conn, user_id, codes[0]) is True
    assert await mfa_service.verify_and_consume_backup_code(sa_conn, user_id, codes[0]) is False


# ── Restricted enrollment credential ──────────────────────────────────────────
async def test_pending_token_peek_does_not_consume_it(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn)
    raw = await mfa_service.mint_mfa_pending(sa_conn, org_id, user_id)
    for _ in range(3):
        assert await mfa_service.peek_mfa_pending(sa_conn, raw) == (user_id, org_id)


async def test_restricted_credential_stops_working_once_enrolled(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn)
    raw = await mfa_service.mint_mfa_pending(sa_conn, org_id, user_id)
    # Works while unenrolled.
    resolved = await mfa_service.resolve_enrollment_actor(
        sa_conn, principal_user_id=None, principal_org_id=None, pending_token=raw
    )
    assert resolved == (user_id, org_id)

    await sa_conn.execute(text("UPDATE users SET mfa_enrolled = true WHERE id = :id"), {"id": user_id})
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await mfa_service.resolve_enrollment_actor(
            sa_conn, principal_user_id=None, principal_org_id=None, pending_token=raw
        )
    assert exc_info.value.status_code == 403


# ── Route-handler-level regressions ───────────────────────────────────────────
# These three exercise the actual route handlers (not just mfa_service
# functions) against a real Postgres via `sa_engine`, the same "real DB, real
# handler code" shape test_create_org_lockout.py uses. Bearer/JWT
# verification is stubbed out where it would otherwise be exercised — it is
# unrelated to what each bug is about, same convention as that file stubbing
# place_org.
class _FakeRequest:
    """The tiny slice of fastapi.Request that request_context reads."""

    client = None
    headers: dict = {}


async def test_totp_enroll_confirm_requires_step_up_when_already_enrolled(monkeypatch, sa_engine):
    """Regression: resolve_enrollment_actor's principal (Bearer) branch used
    to hand back the actor with no re-auth check at all, so a caller holding
    only a Bearer token could silently overwrite an ALREADY-enrolled user's
    TOTP secret — exactly the damage MFA-disable already refuses to do
    without step-up re-auth (password + a still-valid second factor)."""
    from fastapi import HTTPException, Response

    from app.config import settings
    from app.routes import mfa_totp
    from app.schemas import MfaStepUpRequest, TotpEnrollConfirmRequest
    from crypto import init_cryptor

    # The dev KEK settings already carries is fine for a scratch test
    # database — same as test_create_org_lockout.py's _init_crypto fixture.
    # Only this test and the invalidate-stale-codes one below ever reach the
    # cryptor().encrypt() call, so it's a plain call rather than an
    # autouse fixture that would run pointlessly for every other test here.
    init_cryptor(settings)

    async with sa_engine.begin() as conn:
        org_id, user_id = await _seed_org_and_user(conn)
        await conn.execute(
            text("UPDATE users SET mfa_enrolled = true, password_hash = :h WHERE id = :id"),
            {"h": await hash_password_async(STEP_UP_PASSWORD), "id": user_id},
        )
        step_up_codes = mfa_service.generate_backup_codes(1)
        await mfa_service.store_backup_codes(conn, org_id, user_id, step_up_codes)

    async def _stub_resolve_actor(conn, *, authorization, pending_token):
        # Stands in for a real Bearer principal — JWT minting/verification is
        # unrelated to what this test is about.
        await service.set_org_guc(conn, org_id)
        return user_id, org_id

    monkeypatch.setattr(mfa_service, "resolve_actor_for_enrollment", _stub_resolve_actor)
    monkeypatch.setattr(mfa_totp, "engine", sa_engine)

    def _fresh_body(step_up: MfaStepUpRequest | None = None) -> TotpEnrollConfirmRequest:
        secret = pyotp.random_base32()
        return TotpEnrollConfirmRequest(secret=secret, code=pyotp.TOTP(secret).now(), stepUp=step_up)

    # No step-up at all: must be refused, not silently overwrite the secret.
    with pytest.raises(HTTPException) as exc_info:
        await mfa_totp.enroll_confirm(
            _fresh_body(), _FakeRequest(), Response(), authorization="Bearer irrelevant-stubbed"
        )
    assert exc_info.value.status_code == 401

    async with sa_engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        secret_enc = (
            await conn.execute(
                text("SELECT mfa_totp_secret_enc FROM users WHERE id = :id"), {"id": user_id}
            )
        ).scalar()
    assert secret_enc is None, "the refused attempt must not have overwritten anything"

    # Correct step-up (password + the still-valid backup code): now it may
    # proceed, same as it would for MFA-disable/backup-codes-regenerate.
    result = await mfa_totp.enroll_confirm(
        _fresh_body(MfaStepUpRequest(password=STEP_UP_PASSWORD, backupCode=step_up_codes[0])),
        _FakeRequest(),
        Response(),
        authorization="Bearer irrelevant-stubbed",
    )
    assert result.backupCodes


async def test_totp_enroll_confirm_invalidates_stale_backup_codes_before_storing_new_ones(
    monkeypatch, sa_engine
):
    """Regression: enroll-confirm's docstring (mirrored from
    invalidate_backup_codes's own) requires invalidating every existing
    unused code BEFORE inserting a fresh batch, exactly like backup-codes/
    regenerate already does — otherwise a leftover code from an earlier
    enrollment cycle stays valid indefinitely alongside the new batch."""
    from fastapi import Response

    from app.config import settings
    from app.routes import mfa_totp
    from app.schemas import TotpEnrollConfirmRequest
    from crypto import init_cryptor

    init_cryptor(settings)  # see the step-up test above for why this is needed

    async with sa_engine.begin() as conn:
        org_id, user_id = await _seed_org_and_user(conn)
        stale_codes = mfa_service.generate_backup_codes()
        await mfa_service.store_backup_codes(conn, org_id, user_id, stale_codes)

    async def _stub_resolve_actor(conn, *, authorization, pending_token):
        await service.set_org_guc(conn, org_id)
        return user_id, org_id

    monkeypatch.setattr(mfa_service, "resolve_actor_for_enrollment", _stub_resolve_actor)
    monkeypatch.setattr(mfa_totp, "engine", sa_engine)

    secret = pyotp.random_base32()
    result = await mfa_totp.enroll_confirm(
        TotpEnrollConfirmRequest(secret=secret, code=pyotp.TOTP(secret).now()),
        _FakeRequest(),
        Response(),
        authorization="Bearer irrelevant-stubbed",
    )

    async with sa_engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        for stale in stale_codes:
            assert await mfa_service.verify_and_consume_backup_code(conn, user_id, stale) is False
        assert (
            await mfa_service.verify_and_consume_backup_code(conn, user_id, result.backupCodes[0])
            is True
        )
