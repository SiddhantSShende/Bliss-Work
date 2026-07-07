"""Row-Level-Security isolation against a REAL Postgres with the real policies.

This is the database backstop behind the application's org scoping: even a bug
that leaks a wrong org_id into a query (or a forged one) must not cross orgs,
because the DB itself filters every row by the `app.org_id` GUC. Verifies:

  * org-scoped SELECT only returns the active org's rows
  * an UNSET org GUC returns ZERO rows (fail closed) — not everything
  * a forged WHERE org_id=<other> still returns nothing under another context
  * WITH CHECK blocks inserting a row into another org
  * UPDATE can't touch another org's rows
  * the trusted app.bypass_rls='on' path sees all orgs (for cross-org svc code)

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

pytestmark = pytest.mark.integration

ORG_A = uuid.uuid4()
ORG_B = uuid.uuid4()
USER_A = uuid.uuid4()
USER_B = uuid.uuid4()


async def _set_org(db, org: uuid.UUID) -> None:
    await db.execute("SELECT set_config('app.org_id', $1, false)", str(org))


async def _bypass(db, on: bool) -> None:
    await db.execute("SELECT set_config('app.bypass_rls', $1, false)", "on" if on else "")


async def _seed(db) -> None:
    await _bypass(db, True)
    await db.execute("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", ORG_A, "Org A", f"a-{ORG_A}")
    await db.execute("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", ORG_B, "Org B", f"b-{ORG_B}")
    await db.execute(
        "INSERT INTO users (id, org_id, username, password_hash) VALUES ($1, $2, $3, 'x')",
        USER_A, ORG_A, "alice",
    )
    await db.execute(
        "INSERT INTO users (id, org_id, username, password_hash) VALUES ($1, $2, $3, 'x')",
        USER_B, ORG_B, "bob",
    )
    await _bypass(db, False)


async def test_select_is_org_scoped(db):
    await _seed(db)
    await _set_org(db, ORG_A)
    assert {r["id"] for r in await db.fetch("SELECT id FROM orgs")} == {ORG_A}
    assert {r["id"] for r in await db.fetch("SELECT id FROM users")} == {USER_A}
    await _set_org(db, ORG_B)
    assert {r["id"] for r in await db.fetch("SELECT id FROM users")} == {USER_B}


async def test_unset_org_fails_closed(db):
    await _seed(db)
    await db.execute("SELECT set_config('app.org_id', '', false)")
    assert await db.fetch("SELECT id FROM orgs") == []
    assert await db.fetch("SELECT id FROM users") == []


async def test_forged_where_cannot_cross_org(db):
    await _seed(db)
    await _set_org(db, ORG_A)
    # Explicitly asking for org B's rows still returns nothing under org A.
    assert await db.fetch("SELECT id FROM users WHERE org_id = $1", ORG_B) == []


async def test_with_check_blocks_cross_org_insert(db):
    await _seed(db)
    await _set_org(db, ORG_A)
    with pytest.raises(asyncpg.PostgresError):
        await db.execute(
            "INSERT INTO users (id, org_id, username, password_hash) VALUES ($1, $2, 'mallory', 'x')",
            uuid.uuid4(), ORG_B,  # cross-org row → WITH CHECK violation
        )


async def test_update_cannot_touch_other_org(db):
    await _seed(db)
    await _set_org(db, ORG_A)
    res = await db.execute("UPDATE users SET username = 'hacked' WHERE id = $1", USER_B)
    assert res == "UPDATE 0"  # B's row is invisible under A's context
    await _bypass(db, True)
    row = await db.fetchrow("SELECT username FROM users WHERE id = $1", USER_B)
    assert row["username"] == "bob"  # untouched


async def test_bypass_sees_all_orgs(db):
    await _seed(db)
    await _bypass(db, True)
    assert {r["id"] for r in await db.fetch("SELECT id FROM orgs")} == {ORG_A, ORG_B}
