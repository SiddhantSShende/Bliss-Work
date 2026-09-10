"""request_delete / cancel_delete vs. the purge job: a race guard proven
against a REAL Postgres.

── The bug ─────────────────────────────────────────────────────────────────
`_load()` at the top of each function only sees the state at the START of
the transaction. Postgres READ COMMITTED re-reads fresh, committed data on
EVERY statement in a transaction, not once at BEGIN — so if the purge job
commits between that `_load()` and this transaction's own UPDATE, the UPDATE
sees the row as it is NOW, not as `_load()` reported it.

`request_delete`'s UPDATE had no `deleted_at IS NULL` guard at all, so it
would apply unconditionally to an org the purge job had just erased,
resurrecting delete-scheduling fields on it. `cancel_delete` had the guard
but never checked whether it actually matched a row, so losing the race
still fell through to write a misleading `org.delete_cancelled` audit entry
and event for an org that was actually just purged.

Proving this needs a real transaction: the whole bug is about what a second,
independently-committing transaction can do to a row between two statements
of a first one — nothing a mock connection has an opinion about.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app import service
from app.routes import org_lifecycle
from app.schemas import DeleteOrgRequest
from app.security.auth_dep import Principal

pytestmark = pytest.mark.integration


async def _seed_org_and_admin(conn, **org_fields) -> tuple[str, str, str]:
    """A fresh org with one org_admin member. Returns (org_id, slug, admin_id)."""
    org_id = str(uuid.uuid4())
    admin_id = str(uuid.uuid4())
    slug = f"org-{org_id}"
    await service.set_bypass_rls(conn)
    fields = {"delete_requested_at": None, "delete_requested_by": None, "purge_after": None}
    fields.update(org_fields)
    await conn.execute(
        text(
            "INSERT INTO orgs (id, name, slug, delete_requested_at, delete_requested_by, purge_after) "
            "VALUES (:id, :name, :slug, :dra, :drb, :pa)"
        ),
        {"id": org_id, "name": "Race Co", "slug": slug, "dra": fields["delete_requested_at"],
         "drb": fields["delete_requested_by"], "pa": fields["purge_after"]},
    )
    await conn.execute(
        text("INSERT INTO users (id, org_id, username, password_hash) VALUES (:id, :org, :un, 'x')"),
        {"id": admin_id, "org": org_id, "un": f"admin-{admin_id[:8]}"},
    )
    role_id = (await conn.execute(text("SELECT id FROM roles WHERE name = 'org_admin'"))).scalar()
    await conn.execute(
        text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
        {"u": admin_id, "r": role_id, "o": org_id},
    )
    return org_id, slug, admin_id


async def _mark_purged(sa_engine, org_id: str) -> None:
    """What the purge job's own final UPDATE does to the row (app/jobs/
    purge_orgs.py::purge_one) — run in its OWN transaction, committed
    independently, exactly as the real job would."""
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text(
                "UPDATE orgs SET deleted_at = now(), name = '(deleted)', "
                "delete_requested_by = NULL WHERE id = :id"
            ),
            {"id": org_id},
        )


async def _org_row(sa_engine, org_id: str):
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return (
            await conn.execute(
                text(
                    "SELECT deleted_at, delete_requested_at, purge_after "
                    "FROM orgs WHERE id = :id"
                ),
                {"id": org_id},
            )
        ).first()


async def _audit_and_events(sa_engine, org_id: str, action: str) -> tuple[int, int]:
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        audit_n = (
            await conn.execute(
                text("SELECT count(*) FROM audit_log WHERE org_id = :o AND action = :a"),
                {"o": org_id, "a": action},
            )
        ).scalar_one()
        event_n = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM outbox "
                    "WHERE kafka_key = :o AND payload->>'type' = :t"
                ),
                {"o": org_id, "t": action},
            )
        ).scalar_one()
    return audit_n, event_n


def _race_after_load(sa_engine, org_id: str):
    """A `_load` wrapper that lets the real read happen (so the caller still
    sees the pre-race state, exactly like `_load()`'s SELECT genuinely would
    a moment before the purge job commits), then simulates the purge job
    winning the race in a SEPARATE, independently-committed transaction
    before the caller's own UPDATE runs."""
    real_load = org_lifecycle._load

    async def _wrapped(conn, oid):
        result = await real_load(conn, oid)
        if oid == org_id:
            await _mark_purged(sa_engine, org_id)
        return result

    return _wrapped


async def test_request_delete_does_not_resurrect_an_already_purged_org(
    monkeypatch: pytest.MonkeyPatch, sa_engine
):
    async with sa_engine.begin() as conn:
        org_id, slug, admin_id = await _seed_org_and_admin(conn)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")

    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)
    monkeypatch.setattr(org_lifecycle, "_load", _race_after_load(sa_engine, org_id))

    with pytest.raises(HTTPException) as exc:
        await org_lifecycle.request_delete(DeleteOrgRequest(slug=slug), principal)
    assert exc.value.status_code == 409

    row = await _org_row(sa_engine, org_id)
    assert row.deleted_at is not None, "the org must still be purged"
    # The bug: delete-scheduling fields resurrected on an already-purged org.
    assert row.delete_requested_at is None, "request_delete resurrected delete_requested_at"
    assert row.purge_after is None, "request_delete resurrected purge_after"

    audit_n, event_n = await _audit_and_events(sa_engine, org_id, "org.delete_requested")
    assert audit_n == 0, "a misleading org.delete_requested audit entry was written"
    assert event_n == 0, "a misleading org.delete_requested event was enqueued"


async def test_cancel_delete_does_not_write_a_misleading_event_for_a_purged_org(
    monkeypatch: pytest.MonkeyPatch, sa_engine
):
    future = datetime.now(timezone.utc) + timedelta(days=3)
    async with sa_engine.begin() as conn:
        org_id, slug, admin_id = await _seed_org_and_admin(
            conn,
            delete_requested_at=datetime.now(timezone.utc),
            delete_requested_by=None,
            purge_after=future,
        )
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")

    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)
    monkeypatch.setattr(org_lifecycle, "_load", _race_after_load(sa_engine, org_id))

    with pytest.raises(HTTPException) as exc:
        await org_lifecycle.cancel_delete(principal)
    assert exc.value.status_code == 409

    row = await _org_row(sa_engine, org_id)
    assert row.deleted_at is not None, "the org must still be purged"

    audit_n, event_n = await _audit_and_events(sa_engine, org_id, "org.delete_cancelled")
    assert audit_n == 0, "a misleading org.delete_cancelled audit entry was written"
    assert event_n == 0, "a misleading org.delete_cancelled event was enqueued"


# ── The guard must not misfire on the ordinary, non-race path ───────────────
async def test_request_delete_still_works_when_nothing_races_it(monkeypatch, sa_engine):
    async with sa_engine.begin() as conn:
        org_id, slug, admin_id = await _seed_org_and_admin(conn)
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)

    result = await org_lifecycle.request_delete(DeleteOrgRequest(slug=slug), principal)
    assert result.purgeAfter is not None

    row = await _org_row(sa_engine, org_id)
    assert row.deleted_at is None
    assert row.purge_after is not None

    audit_n, event_n = await _audit_and_events(sa_engine, org_id, "org.delete_requested")
    assert audit_n == 1
    assert event_n == 1


async def test_cancel_delete_still_works_when_nothing_races_it(monkeypatch, sa_engine):
    future = datetime.now(timezone.utc) + timedelta(days=3)
    async with sa_engine.begin() as conn:
        org_id, slug, admin_id = await _seed_org_and_admin(
            conn,
            delete_requested_at=datetime.now(timezone.utc),
            delete_requested_by=None,
            purge_after=future,
        )
    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    monkeypatch.setattr(org_lifecycle, "engine", sa_engine)

    result = await org_lifecycle.cancel_delete(principal)
    assert result.purgeAfter is None

    row = await _org_row(sa_engine, org_id)
    assert row.deleted_at is None
    assert row.purge_after is None

    audit_n, event_n = await _audit_and_events(sa_engine, org_id, "org.delete_cancelled")
    assert audit_n == 1
    assert event_n == 1
