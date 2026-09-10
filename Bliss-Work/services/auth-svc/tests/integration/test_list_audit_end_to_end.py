"""GET /auth/audit against a REAL Postgres: it must actually return rows.

── The bug ─────────────────────────────────────────────────────────────────
`list_audit`'s query bound `action`/`target` as bare parameters compared
against NULL on every call that didn't filter by them — which is every call
today, since no caller sends either filter. asyncpg cannot infer a type for a
parameter that only ever appears against NULL, so this raised
`AmbiguousParameterError` on every single request, turned into an opaque 500
by the generic exception handler. The existing cursor-validation unit test
(test_list_audit_cursor_validation.py) stubs the database out entirely and so
never actually ran the query — it could not have caught this. Only a real
database proves the endpoint works end-to-end.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app import service
from app.routes import members as members_routes
from app.security.auth_dep import Principal

pytestmark = pytest.mark.integration


async def _seed_org_with_admin(sa_engine) -> tuple[str, str]:
    org_id = str(uuid.uuid4())
    admin_id = str(uuid.uuid4())
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)"),
            {"id": org_id, "name": "Q Co", "slug": f"q-{org_id}"},
        )
        admin_role = (
            await conn.execute(text("SELECT id FROM roles WHERE name = 'org_admin'"))
        ).scalar()
        await conn.execute(
            text(
                "INSERT INTO users (id, org_id, username, password_hash) "
                "VALUES (:id, :org, 'admin-0', 'x')"
            ),
            {"id": admin_id, "org": org_id},
        )
        await conn.execute(
            text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
            {"u": admin_id, "r": admin_role, "o": org_id},
        )
        await service.set_org_guc(conn, org_id)
        await service.write_audit(
            conn, org_id=org_id, actor_id=admin_id, action="member.suspended", target=admin_id
        )
        await service.write_audit(
            conn, org_id=org_id, actor_id=admin_id, action="member.role_changed", target=admin_id
        )
    return org_id, admin_id


async def test_list_audit_returns_seeded_entries_with_no_filters(monkeypatch, sa_engine):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    org_id, admin_id = await _seed_org_with_admin(sa_engine)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="a")

    # Explicit None/50 here (not relying on the function's own Python-level
    # defaults, which are FastAPI `Query(...)` sentinel objects that only
    # resolve to real values when a request goes through the framework) is
    # what makes this call the equivalent of a real client omitting
    # before/action/target entirely — the exact call that used to 500
    # unconditionally.
    page = await members_routes.list_audit(
        before=None, limit=50, action=None, targetId=None, principal=principal
    )

    actions = {e.action for e in page.entries}
    assert actions == {"member.suspended", "member.role_changed"}
    assert all(e.id for e in page.entries)


async def test_list_audit_action_filter_narrows_correctly(monkeypatch, sa_engine):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    org_id, admin_id = await _seed_org_with_admin(sa_engine)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="a")

    page = await members_routes.list_audit(
        before=None, limit=50, action="member.suspended", targetId=None, principal=principal
    )

    assert [e.action for e in page.entries] == ["member.suspended"]


async def test_list_audit_target_filter_narrows_correctly(monkeypatch, sa_engine):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    org_id, admin_id = await _seed_org_with_admin(sa_engine)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="a")

    page = await members_routes.list_audit(
        before=None, limit=50, action=None, targetId="nobody-matches-this", principal=principal
    )

    assert page.entries == []
