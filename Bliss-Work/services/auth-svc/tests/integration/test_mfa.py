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
  * A full WebAuthn registration + authentication round trip against
    hand-built-but-real test vectors (tests/webauthn_vectors.py), including
    the zero-signcount exemption and cross-user credential scoping.

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
from app.routes.mfa_webauthn import verify_webauthn_assertion
from webauthn_vectors import WebauthnAuthenticator

pytestmark = pytest.mark.integration

RP_ID = "localhost"
ORIGIN = "http://localhost:5173"


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


# ── WebAuthn: real crypto, hand-built vectors ─────────────────────────────────
async def test_webauthn_registration_and_authentication_round_trip(sa_conn):
    org_id, user_id = await _seed_org_and_user(sa_conn)
    await service.set_org_guc(sa_conn, org_id)
    authenticator = WebauthnAuthenticator()

    reg_challenge = await mfa_service.mint_webauthn_challenge(sa_conn, org_id, user_id)
    reg_credential = authenticator.registration_response(
        rp_id=RP_ID, origin=ORIGIN, challenge=reg_challenge, sign_count=0
    )
    from webauthn import verify_registration_response

    # Mirrors register_finish's own order: consume the challenge (single-use)
    # before trusting anything else about the ceremony.
    consumed_user, consumed_org = await mfa_service.consume_webauthn_challenge(sa_conn, reg_challenge)
    assert (consumed_user, consumed_org) == (user_id, org_id)
    with pytest.raises(Exception):  # noqa: B017 - HTTPException from account_service.consume_token
        await mfa_service.consume_webauthn_challenge(sa_conn, reg_challenge)

    verified = verify_registration_response(
        credential=reg_credential,
        expected_challenge=reg_challenge,
        expected_rp_id=RP_ID,
        expected_origin=ORIGIN,
    )
    await sa_conn.execute(
        text(
            "INSERT INTO mfa_webauthn_credentials (id, user_id, org_id, credential_id, public_key, sign_count) "
            "VALUES (:id, :uid, :org, :cid, :pk, :sc)"
        ),
        {
            "id": str(uuid.uuid4()),
            "uid": user_id,
            "org": org_id,
            "cid": verified.credential_id,
            "pk": verified.credential_public_key,
            "sc": verified.sign_count,
        },
    )

    auth_challenge = await mfa_service.mint_webauthn_challenge(sa_conn, org_id, user_id)
    auth_credential = authenticator.authentication_response(
        rp_id=RP_ID, origin=ORIGIN, challenge=auth_challenge, sign_count=1
    )
    resolved_user, resolved_org = await verify_webauthn_assertion(sa_conn, auth_credential)
    assert (resolved_user, resolved_org) == (user_id, org_id)

    new_sign_count = (
        await sa_conn.execute(
            text("SELECT sign_count FROM mfa_webauthn_credentials WHERE user_id = :uid"),
            {"uid": user_id},
        )
    ).scalar()
    assert new_sign_count == 1


async def test_webauthn_zero_sign_count_is_not_flagged_as_cloned(sa_conn):
    """Several platform authenticators (Touch ID/Face ID) never implement a
    signature counter and permanently report 0 — stored=0 and assertion=0 must
    NOT be treated as a replay."""
    org_id, user_id = await _seed_org_and_user(sa_conn)
    await service.set_org_guc(sa_conn, org_id)
    authenticator = WebauthnAuthenticator()

    reg_challenge = await mfa_service.mint_webauthn_challenge(sa_conn, org_id, user_id)
    reg_credential = authenticator.registration_response(
        rp_id=RP_ID, origin=ORIGIN, challenge=reg_challenge, sign_count=0
    )
    from webauthn import verify_registration_response

    verified = verify_registration_response(
        credential=reg_credential,
        expected_challenge=reg_challenge,
        expected_rp_id=RP_ID,
        expected_origin=ORIGIN,
    )
    await sa_conn.execute(
        text(
            "INSERT INTO mfa_webauthn_credentials (id, user_id, org_id, credential_id, public_key, sign_count) "
            "VALUES (:id, :uid, :org, :cid, :pk, 0)"
        ),
        {"id": str(uuid.uuid4()), "uid": user_id, "org": org_id, "cid": verified.credential_id, "pk": verified.credential_public_key},
    )

    for _ in range(2):  # a zero-counter authenticator reports 0 on EVERY use
        challenge = await mfa_service.mint_webauthn_challenge(sa_conn, org_id, user_id)
        credential = authenticator.authentication_response(
            rp_id=RP_ID, origin=ORIGIN, challenge=challenge, sign_count=0
        )
        resolved_user, _ = await verify_webauthn_assertion(sa_conn, credential)
        assert resolved_user == user_id


async def test_webauthn_credential_id_is_scoped_to_the_right_user(sa_conn):
    """A credential_id that exists, but for a DIFFERENT user, must fail exactly
    like one that does not exist at all."""
    org_id, victim_id = await _seed_org_and_user(sa_conn)
    _org2, attacker_id = await _seed_org_and_user(sa_conn)
    await service.set_org_guc(sa_conn, org_id)
    authenticator = WebauthnAuthenticator()

    reg_challenge = await mfa_service.mint_webauthn_challenge(sa_conn, org_id, victim_id)
    reg_credential = authenticator.registration_response(
        rp_id=RP_ID, origin=ORIGIN, challenge=reg_challenge, sign_count=0
    )
    from webauthn import verify_registration_response

    verified = verify_registration_response(
        credential=reg_credential,
        expected_challenge=reg_challenge,
        expected_rp_id=RP_ID,
        expected_origin=ORIGIN,
    )
    # Registered to the VICTIM.
    await sa_conn.execute(
        text(
            "INSERT INTO mfa_webauthn_credentials (id, user_id, org_id, credential_id, public_key, sign_count) "
            "VALUES (:id, :uid, :org, :cid, :pk, 0)"
        ),
        {"id": str(uuid.uuid4()), "uid": victim_id, "org": org_id, "cid": verified.credential_id, "pk": verified.credential_public_key},
    )

    # A challenge minted for the ATTACKER, answered with the VICTIM's
    # credential — consume_webauthn_challenge resolves user_id=attacker_id, so
    # the credential lookup (scoped to attacker_id) must find nothing.
    attacker_challenge = await mfa_service.mint_webauthn_challenge(sa_conn, org_id, attacker_id)
    forged = authenticator.authentication_response(
        rp_id=RP_ID, origin=ORIGIN, challenge=attacker_challenge, sign_count=1
    )
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await verify_webauthn_assertion(sa_conn, forged)
    assert exc_info.value.status_code == 401
