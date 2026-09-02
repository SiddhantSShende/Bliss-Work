"""app/jobs/purge_orgs.py::run() against a REAL Postgres: one org's purge
failure must not roll back orgs already purged earlier in the same run, nor
block orgs still due after it.

── The bug ─────────────────────────────────────────────────────────────────
`run()` used to select every due org via `_due()` and purge all of them
inside ONE shared `engine.begin()` transaction/connection. If `purge_one`
raised for any single org — this has already happened once in production: an
FK from a table not yet added to `PURGE_STATEMENTS` — the WHOLE transaction
rolled back, undoing every org already successfully purged earlier in that
run. The next day's run reselects the identical list in the identical order
and fails at the identical org again, so everything behind it in
`purge_after` order never gets purged, silently, forever.

This can only be proven against a real transactional database — a mock
connection cannot show that a rollback on one org's work leaves ANOTHER
org's already-committed work intact, because that is exactly the property a
mock has no transaction semantics to violate.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app import service
from app.jobs import purge_orgs

pytestmark = pytest.mark.integration


class _FakeLog:
    """Records what would have gone to structlog, so a test can assert a
    failure is actually reported rather than silently swallowed."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def _record(self, level: str, event: str, *args, **kwargs) -> None:
        self.calls.append((level, (event, *args), kwargs))

    def info(self, event: str, *args, **kwargs) -> None:
        self._record("info", event, *args, **kwargs)

    def warning(self, event: str, *args, **kwargs) -> None:
        self._record("warning", event, *args, **kwargs)

    def exception(self, event: str, *args, **kwargs) -> None:
        self._record("exception", event, *args, **kwargs)


async def _seed_due_org(conn, *, purge_after: datetime) -> str:
    org_id = str(uuid.uuid4())
    await conn.execute(
        text(
            "INSERT INTO orgs (id, name, slug, delete_requested_at, "
            "delete_requested_by, purge_after) "
            "VALUES (:id, :name, :slug, now(), :by, :after)"
        ),
        {
            "id": org_id,
            "name": f"Org {org_id[:8]}",
            "slug": f"org-{org_id}",
            "by": str(uuid.uuid4()),
            "after": purge_after,
        },
    )
    return org_id


async def _deleted_at(conn, org_id: str):
    row = (
        await conn.execute(text("SELECT deleted_at FROM orgs WHERE id = :id"), {"id": org_id})
    ).first()
    assert row is not None, f"org {org_id} row vanished entirely — it must only ever be marked, not dropped"
    return row.deleted_at


async def test_one_org_failing_does_not_roll_back_or_block_the_others(
    monkeypatch: pytest.MonkeyPatch, sa_engine
):
    now = datetime.now(timezone.utc)
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        # Due order (ORDER BY purge_after) is B, A, C — B already succeeded
        # by the time A fails; C is still queued behind A.
        org_b = await _seed_due_org(conn, purge_after=now - timedelta(days=3))
        org_a = await _seed_due_org(conn, purge_after=now - timedelta(days=2))
        org_c = await _seed_due_org(conn, purge_after=now - timedelta(days=1))

    real_purge_one = purge_orgs.purge_one

    async def _purge_one_a_fails(conn, org_id: str, slug, requested_by):
        # Let the real purge run to completion — proving even fully-applied
        # but uncommitted work for A is what gets undone, not some earlier
        # no-op — then fail exactly like `purge_one` raising for real would.
        await real_purge_one(conn, org_id, slug, requested_by)
        if org_id == org_a:
            raise RuntimeError("simulated: FK from a table purge_one doesn't know about yet")

    fake_log = _FakeLog()
    monkeypatch.setattr(purge_orgs, "engine", sa_engine)
    monkeypatch.setattr(purge_orgs, "purge_one", _purge_one_a_fails)
    monkeypatch.setattr(purge_orgs, "log", fake_log)

    # The job must not crash the whole run over one org's failure.
    purged_count = await purge_orgs.run()

    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        deleted_b = await _deleted_at(conn, org_b)
        deleted_a = await _deleted_at(conn, org_a)
        deleted_c = await _deleted_at(conn, org_c)

    # (a) B, purged before A failed, stays purged — not undone by A's rollback.
    assert deleted_b is not None, "org B's successful purge was rolled back by A's later failure"
    # A's own transaction rolled back: it must look completely untouched,
    # still due, ready to be retried on the next run.
    assert deleted_a is None, "org A was left half-purged instead of cleanly rolled back"
    # (b) C, due AFTER A, still gets purged in the SAME run — not blocked by
    # A's failure or left for some future run.
    assert deleted_c is not None, "org C was blocked by A's failure instead of still being purged"

    assert purged_count == 2, f"expected exactly B and C counted as purged, got {purged_count}"

    # The failure is reported, not swallowed — see the file header on why a
    # swallowed failure here is indistinguishable from "nothing was due".
    exceptions = [c for c in fake_log.calls if c[0] == "exception"]
    assert exceptions, "org A's failure was never logged"
    assert any(org_a in str(kwargs.get("org_id")) for _lvl, _args, kwargs in exceptions), (
        "the logged failure does not identify which org failed"
    )


async def test_purge_after_ordering_matters_for_which_orgs_are_ahead_of_the_failure(sa_engine):
    """Sanity check on the seeding helper's ordering assumption: `_due()`
    really does return oldest-`purge_after`-first, so "B before A" and
    "C after A" above are meaningful rather than accidental."""
    now = datetime.now(timezone.utc)
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        org_b = await _seed_due_org(conn, purge_after=now - timedelta(days=3))
        org_a = await _seed_due_org(conn, purge_after=now - timedelta(days=2))
        org_c = await _seed_due_org(conn, purge_after=now - timedelta(days=1))
        due = await purge_orgs._due(conn)

    assert [row[0] for row in due] == [org_b, org_a, org_c]
