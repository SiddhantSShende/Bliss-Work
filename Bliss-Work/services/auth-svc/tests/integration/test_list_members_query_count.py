"""GET /auth/members against a REAL Postgres: the N+1 fix.

── The bug ─────────────────────────────────────────────────────────────────
`list_members` used to run a bare `SELECT id FROM users WHERE org_id = :org`
with no LIMIT, then call `load_member()` — 3+ queries of its own — once per
row. For an org with N members that is 3N+1 round trips; the fix
(`members_service.load_members_for_org`, modelled on
`service.user_dtos_for_org`) answers the same request in a query count that
does NOT grow with N.

Proving "the query count doesn't grow with N" needs to actually run two
differently-sized orgs through the real endpoint and count statements sent to
a real database — a mock has no round trips to count.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import event, text

from app import service
from app.config import settings
from app.routes import members as members_routes
from app.security.auth_dep import Principal
from crypto import init_cryptor

pytestmark = pytest.mark.integration

_STATUSES = ("active", "suspended", "removed")


@pytest.fixture(autouse=True)
def _init_crypto():
    # load_members_for_org decrypts each member's email/displayName/avatar —
    # the dev KEK in settings' defaults is fine for a scratch test database.
    init_cryptor(settings)


async def _seed_org_with_members(sa_engine, n: int) -> tuple[str, str]:
    """One org_admin plus `n` additional members with a mix of statuses.
    Returns (org_id, admin_id)."""
    org_id = str(uuid.uuid4())
    admin_id = str(uuid.uuid4())
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)"),
            {"id": org_id, "name": "Q Co", "slug": f"q-{org_id}"},
        )
        admin_role = (await conn.execute(text("SELECT id FROM roles WHERE name = 'org_admin'"))).scalar()
        member_role = (await conn.execute(text("SELECT id FROM roles WHERE name = 'member'"))).scalar()

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

        for i in range(n):
            uid = str(uuid.uuid4())
            status = _STATUSES[i % len(_STATUSES)]
            await conn.execute(
                text(
                    "INSERT INTO users (id, org_id, username, password_hash, status, removed_at) "
                    "VALUES (:id, :org, :un, 'x', :status, "
                    "CASE WHEN :status = 'removed' THEN now() ELSE NULL END)"
                ),
                {"id": uid, "org": org_id, "un": f"member-{i:04d}", "status": status},
            )
            await conn.execute(
                text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
                {"u": uid, "r": member_role, "o": org_id},
            )
    return org_id, admin_id


class _QueryCounter:
    def __init__(self, engine) -> None:
        self._engine = engine
        self.log: list[str] = []

    def _listener(self, _conn, _cursor, statement, *_rest) -> None:
        self.log.append(statement)

    def __enter__(self) -> "_QueryCounter":
        event.listen(self._engine.sync_engine, "before_cursor_execute", self._listener)
        return self

    def __exit__(self, *_exc) -> None:
        event.remove(self._engine.sync_engine, "before_cursor_execute", self._listener)


async def test_query_count_does_not_grow_with_member_count(monkeypatch, sa_engine):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    org_small, admin_small = await _seed_org_with_members(sa_engine, 3)
    org_big, admin_big = await _seed_org_with_members(sa_engine, 40)

    principal_small = Principal(user_id=admin_small, org_id=org_small, roles=["org_admin"], username="a")
    principal_big = Principal(user_id=admin_big, org_id=org_big, roles=["org_admin"], username="b")

    # Warm-up call (outside the counted window): absorbs any one-time cost of
    # the first pooled connection (e.g. the RLS `SET ROLE`), so it cannot be
    # mistaken for a per-request cost that only the first measurement pays.
    await members_routes.list_members(limit=None, principal=principal_small)

    counter = _QueryCounter(sa_engine)
    with counter:
        start = len(counter.log)
        result_small = await members_routes.list_members(limit=None, principal=principal_small)
        n_small = len(counter.log) - start

        start = len(counter.log)
        result_big = await members_routes.list_members(limit=None, principal=principal_big)
        n_big = len(counter.log) - start

    assert len(result_small) == 4, "1 admin + 3 members"
    assert len(result_big) == 41, "1 admin + 40 members"

    assert n_small == n_big, (
        f"query count grew with member count ({n_small} for 4 members vs "
        f"{n_big} for 41) — the N+1 loop is back"
    )
    # set_org_guc + the members SELECT + the batched roles SELECT.
    assert n_small <= 4, f"expected O(1) queries regardless of member count, issued {n_small}"


async def test_returns_every_status_correctly_ordered_and_shaped(monkeypatch, sa_engine):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    org_id, admin_id = await _seed_org_with_members(sa_engine, 3)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="a")

    members = await members_routes.list_members(limit=None, principal=principal)

    assert len(members) == 4
    assert admin_id in {m.id for m in members}
    by_username = {m.username: m for m in members}
    assert by_username["admin-0"].status == "active"
    assert by_username["admin-0"].roles == ["org_admin"]
    assert by_username["member-0000"].status == "active"
    assert by_username["member-0001"].status == "suspended"
    assert by_username["member-0002"].status == "removed"
    assert by_username["member-0002"].removedAt is not None
    assert by_username["member-0000"].removedAt is None

    # Active members sort before non-active ones; alphabetical within each group.
    active_usernames = [m.username for m in members if m.status == "active"]
    assert active_usernames == sorted(active_usernames)
    first_non_active = next(i for i, m in enumerate(members) if m.status != "active")
    assert all(m.status == "active" for m in members[:first_non_active])


async def test_optional_limit_caps_the_result_without_changing_default_behaviour(monkeypatch, sa_engine):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    org_id, admin_id = await _seed_org_with_members(sa_engine, 5)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="a")

    everyone = await members_routes.list_members(limit=None, principal=principal)
    assert len(everyone) == 6, "omitting limit must still return every member, unchanged"

    capped = await members_routes.list_members(limit=2, principal=principal)
    assert len(capped) == 2
    assert [m.id for m in capped] == [m.id for m in everyone[:2]], (
        "limit must cap the SAME ordering, not pick an arbitrary subset"
    )
