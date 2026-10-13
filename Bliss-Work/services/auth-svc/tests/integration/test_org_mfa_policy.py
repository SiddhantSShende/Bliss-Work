"""GET/POST /auth/org/mfa: the mandatory-MFA-for-admins policy toggle.

Nothing previously exercised this pair of endpoints end-to-end against a real
Postgres — `test_mfa.py` covers `mfa_service.mfa_gate` directly (the
login-time consequence of the flag), but never the route that actually
flips `orgs.require_mfa_for_admins` / `orgs.mfa_grace_period_ends_at`, nor
its audit trail or its re-verified-admin guard.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app import service
from app.config import settings
from app.routes import org_lifecycle
from app.schemas import OrgMfaSettingsRequest
from app.security.auth_dep import Principal

pytestmark = pytest.mark.integration


async def _seed_org_and_admin(conn, *, roles: list[str] = ["org_admin"]) -> tuple[str, str]:
    """A fresh org with one member holding `roles`. Returns (org_id, user_id)."""
    org_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    await service.set_bypass_rls(conn)
    await conn.execute(
        text("INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)"),
        {"id": org_id, "name": "Policy Co", "slug": f"org-{org_id}"},
    )
    await conn.execute(
        text("INSERT INTO users (id, org_id, username, password_hash) VALUES (:id, :org, :un, 'x')"),
        {"id": user_id, "org": org_id, "un": f"user-{user_id[:8]}"},
    )
    for role in roles:
        role_id = (await conn.execute(text("SELECT id FROM roles WHERE name = :r"), {"r": role})).scalar()
        await conn.execute(
            text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
            {"u": user_id, "r": role_id, "o": org_id},
        )
    return org_id, user_id


async def _org_mfa_row(sa_engine, org_id: str):
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return (
            await conn.execute(
                text("SELECT require_mfa_for_admins, mfa_grace_period_ends_at FROM orgs WHERE id = :id"),
                {"id": org_id},
            )
        ).first()


async def _audit_count(sa_engine, org_id: str, action: str) -> int:
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return (
            await conn.execute(
                text("SELECT count(*) FROM audit_log WHERE org_id = :o AND action = :a"),
                {"o": org_id, "a": action},
            )
        ).scalar_one()


async def test_get_reflects_the_off_default(monkeypatch, sa_engine):
    async with sa_engine.begin() as conn:
        org_id, admin_id = await _seed_org_and_admin(conn)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)

    result = await org_lifecycle.get_mfa_settings(principal)
    assert result.requireMfaForAdmins is False
    assert result.mfaGracePeriodEndsAt is None


async def test_turning_on_stamps_a_fresh_grace_deadline_and_writes_audit(monkeypatch, sa_engine):
    async with sa_engine.begin() as conn:
        org_id, admin_id = await _seed_org_and_admin(conn)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)

    before = datetime.now(timezone.utc)
    result = await org_lifecycle.set_mfa_settings(
        OrgMfaSettingsRequest(requireMfaForAdmins=True), principal
    )
    after = datetime.now(timezone.utc)

    assert result.requireMfaForAdmins is True
    assert result.mfaGracePeriodEndsAt is not None
    deadline = datetime.fromisoformat(result.mfaGracePeriodEndsAt.replace("Z", "+00:00"))
    expected_low = before + timedelta(days=settings.mfa_grace_period_days) - timedelta(seconds=5)
    expected_high = after + timedelta(days=settings.mfa_grace_period_days) + timedelta(seconds=5)
    assert expected_low <= deadline <= expected_high

    row = await _org_mfa_row(sa_engine, org_id)
    assert row.require_mfa_for_admins is True
    assert row.mfa_grace_period_ends_at is not None

    assert await _audit_count(sa_engine, org_id, "org.mfa_policy_changed") == 1


async def test_turning_off_clears_the_deadline_outright(monkeypatch, sa_engine):
    async with sa_engine.begin() as conn:
        org_id, admin_id = await _seed_org_and_admin(conn)
        await conn.execute(
            text(
                "UPDATE orgs SET require_mfa_for_admins = true, "
                "mfa_grace_period_ends_at = now() + interval '14 days' WHERE id = :id"
            ),
            {"id": org_id},
        )
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)

    result = await org_lifecycle.set_mfa_settings(
        OrgMfaSettingsRequest(requireMfaForAdmins=False), principal
    )
    assert result.requireMfaForAdmins is False
    assert result.mfaGracePeriodEndsAt is None

    row = await _org_mfa_row(sa_engine, org_id)
    assert row.require_mfa_for_admins is False
    # The stale deadline must not survive switching off, or re-enabling later
    # would see an already-past grace period from a previous cycle.
    assert row.mfa_grace_period_ends_at is None


async def test_a_demoted_admin_is_rejected_even_with_a_stale_org_admin_claim(monkeypatch, sa_engine):
    """`require_live_admin` re-checks the DB specifically so a just-demoted
    admin's still-valid ~15-minute JWT cannot be used to grant/revoke this
    policy — see members_service.require_live_admin's docstring."""
    async with sa_engine.begin() as conn:
        org_id, user_id = await _seed_org_and_admin(conn, roles=["member"])
    # Stale claim: the bearer token still says org_admin even though the DB
    # (checked above) only has `member` for this user.
    principal = Principal(user_id=user_id, org_id=org_id, roles=["org_admin"], username="demoted")
    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)

    with pytest.raises(HTTPException) as exc:
        await org_lifecycle.set_mfa_settings(OrgMfaSettingsRequest(requireMfaForAdmins=True), principal)
    assert exc.value.status_code == 403

    row = await _org_mfa_row(sa_engine, org_id)
    assert row.require_mfa_for_admins is False, "a rejected request must not have mutated the policy"
    assert await _audit_count(sa_engine, org_id, "org.mfa_policy_changed") == 0
