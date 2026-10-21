"""GET /internal/v1/orgs/{org_id}/admins against a REAL Postgres.

notification-svc's billing consumer needs "the org's current admins" to route
membership.low_balance / grace_started / suspended notices. This endpoint
reuses `members_service._active_admin_ids` — the exact same query that already
guards the no-last-admin invariant elsewhere in this service — so there is
only one source of truth for who administers an org.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app import service
from app.routes import internal as internal_routes

pytestmark = pytest.mark.integration

TOKEN = "t" * 32


async def _seed_org(sa_engine, *, members: list[tuple[str, str, str]]) -> str:
    """members: list of (user_id, username, role_name_or_None). Role None
    means no role row (used for a removed/role-changed member)."""
    org_id = str(uuid.uuid4())
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, 'Admins Co', :slug)"),
            {"id": org_id, "slug": f"a-{org_id}"},
        )
        role_ids = {
            name: (await conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": name})).scalar()
            for name in ("org_admin", "member")
        }
        for uid, username, role_name, status in members:
            await conn.execute(
                text(
                    "INSERT INTO users (id, org_id, username, password_hash, status, removed_at) "
                    "VALUES (:id, :org, :u, 'x', :status, "
                    "CASE WHEN :status = 'removed' THEN now() ELSE NULL END)"
                ),
                {"id": uid, "org": org_id, "u": username, "status": status},
            )
            if role_name is not None:
                await conn.execute(
                    text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
                    {"u": uid, "r": role_ids[role_name], "o": org_id},
                )
    return org_id


async def test_returns_only_current_active_admins(monkeypatch, sa_engine):
    monkeypatch.setattr(internal_routes, "engine", sa_engine)
    monkeypatch.setattr(internal_routes, "_INTERNAL_TOKEN", TOKEN)
    admin_id = str(uuid.uuid4())
    member_id = str(uuid.uuid4())
    org_id = await _seed_org(
        sa_engine,
        members=[
            (admin_id, "admin-0", "org_admin", "active"),
            (member_id, "member-0", "member", "active"),
        ],
    )

    result = await internal_routes.internal_org_admins(org_id, x_internal_token=TOKEN)

    assert result == {"adminUserIds": sorted([admin_id])}


async def test_cross_org_isolation(monkeypatch, sa_engine):
    monkeypatch.setattr(internal_routes, "engine", sa_engine)
    monkeypatch.setattr(internal_routes, "_INTERNAL_TOKEN", TOKEN)
    admin_a = str(uuid.uuid4())
    admin_b = str(uuid.uuid4())
    org_a = await _seed_org(sa_engine, members=[(admin_a, "a-admin", "org_admin", "active")])
    org_b = await _seed_org(sa_engine, members=[(admin_b, "b-admin", "org_admin", "active")])

    result_a = await internal_routes.internal_org_admins(org_a, x_internal_token=TOKEN)
    result_b = await internal_routes.internal_org_admins(org_b, x_internal_token=TOKEN)

    assert result_a == {"adminUserIds": [admin_a]}
    assert result_b == {"adminUserIds": [admin_b]}


async def test_removed_and_role_changed_admins_excluded(monkeypatch, sa_engine):
    monkeypatch.setattr(internal_routes, "engine", sa_engine)
    monkeypatch.setattr(internal_routes, "_INTERNAL_TOKEN", TOKEN)
    live_admin = str(uuid.uuid4())
    removed_admin = str(uuid.uuid4())
    demoted_admin = str(uuid.uuid4())
    org_id = await _seed_org(
        sa_engine,
        members=[
            (live_admin, "live", "org_admin", "active"),
            (removed_admin, "gone", "org_admin", "removed"),
            (demoted_admin, "demoted", "member", "active"),
        ],
    )

    result = await internal_routes.internal_org_admins(org_id, x_internal_token=TOKEN)

    assert result == {"adminUserIds": [live_admin]}


async def test_org_with_zero_admins_returns_empty_list(monkeypatch, sa_engine):
    monkeypatch.setattr(internal_routes, "engine", sa_engine)
    monkeypatch.setattr(internal_routes, "_INTERNAL_TOKEN", TOKEN)
    member_id = str(uuid.uuid4())
    org_id = await _seed_org(sa_engine, members=[(member_id, "lonely", "member", "active")])

    result = await internal_routes.internal_org_admins(org_id, x_internal_token=TOKEN)

    assert result == {"adminUserIds": []}


async def test_bad_internal_token_is_rejected(monkeypatch, sa_engine):
    monkeypatch.setattr(internal_routes, "engine", sa_engine)
    monkeypatch.setattr(internal_routes, "_INTERNAL_TOKEN", TOKEN)
    org_id = await _seed_org(sa_engine, members=[])

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await internal_routes.internal_org_admins(org_id, x_internal_token="wrong")
    assert exc_info.value.status_code == 401
