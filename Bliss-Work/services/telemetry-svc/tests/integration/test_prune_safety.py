"""assert_rolled_up, against a real Postgres.

── Why this cannot be a Go/pure-Python unit test ────────────────────────────
The bug this file exists to catch was invisible without real data: the
original check asked "does ANY row exist in activity_daily for this day",
with no org_id filter, even though rollups are computed per (org_id, user_id,
day) — activity_daily's own primary key. Two orgs with activity on the same
day, only one of them rolled up, is exactly the case a single-table EXISTS
cannot distinguish from "everyone is rolled up" — and it can only be exercised
against the real partitioned schema and the real per-org rollup rows, not a
mock.

    TELEMETRY_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/telemetrydb_scratch \\
        python -m pytest tests/integration/test_prune_safety.py -q

See test_sessionizer.py's header for why this only runs opt-in.
"""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

pytest_asyncio = pytest.importorskip("pytest_asyncio")

from sqlalchemy import text  # noqa: E402

from app.db import (  # noqa: E402
    dispose_engine,
    init_engine,
    run_migrations,
    session as db_session,
    set_bypass_rls,
)
from app.jobs.prune import UnrolledDayError, assert_rolled_up  # noqa: E402


@pytest_asyncio.fixture(loop_scope="module", scope="module", autouse=True)
async def _migrated_db():
    init_engine()
    await run_migrations()
    yield
    await dispose_engine()


async def _seed_event(org_id: str, day: date) -> None:
    async with db_session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text(
                "INSERT INTO activity_events "
                "(id, org_id, user_id, occurred_at, source, category, action) "
                "VALUES (:id, :org, :user, :at, 'server', 'engagement', 'test.event')"
            ),
            {
                "id": str(uuid.uuid4()),
                "org": org_id,
                "user": str(uuid.uuid4()),
                "at": datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
                + timedelta(hours=12),
            },
        )
        await db.commit()


async def _seed_rollup(org_id: str, day: date) -> None:
    async with db_session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text(
                "INSERT INTO activity_daily (org_id, user_id, day) "
                "VALUES (:org, :user, :day)"
            ),
            {"org": org_id, "user": str(uuid.uuid4()), "day": day},
        )
        await db.commit()


# Each test below uses a DISTINCT day. All three run against the same
# scratch database without a per-test rollback, and assert_rolled_up scans
# every org's events for the day given — reusing a day across tests would let
# one test's seeded (unrolled) org leak into another test's "no events" or
# "everyone rolled up" assertion. today .. today+2 are all guaranteed to
# already have a partition (migrations call ensure_activity_partitions(30) at
# startup, covering yesterday through +30 days), so no extra setup is needed.
_DAY_ONE_ORG_UNROLLED = date.today()
_DAY_EVERY_ORG_ROLLED_UP = date.today() + timedelta(days=1)
_DAY_NO_EVENTS = date.today() + timedelta(days=2)


# ── The bug: one org's missing rollup must not be hidden by another org's ────
async def test_one_orgs_unrolled_day_is_not_hidden_by_another_orgs_rollup():
    day = _DAY_ONE_ORG_UNROLLED
    rolled_org = str(uuid.uuid4())
    unrolled_org = str(uuid.uuid4())

    await _seed_event(rolled_org, day)
    await _seed_rollup(rolled_org, day)
    await _seed_event(unrolled_org, day)
    # unrolled_org deliberately gets NO activity_daily row for this day.

    async with db_session() as db:
        await set_bypass_rls(db)
        with pytest.raises(UnrolledDayError):
            await assert_rolled_up(db, day)


# ── Every org actually rolled up: no refusal ──────────────────────────────────
async def test_every_org_rolled_up_passes():
    day = _DAY_EVERY_ORG_ROLLED_UP
    org_a = str(uuid.uuid4())
    org_b = str(uuid.uuid4())

    await _seed_event(org_a, day)
    await _seed_rollup(org_a, day)
    await _seed_event(org_b, day)
    await _seed_rollup(org_b, day)

    async with db_session() as db:
        await set_bypass_rls(db)
        await assert_rolled_up(db, day)  # must not raise


# ── No events at all: nothing to lose, no refusal ─────────────────────────────
async def test_day_with_no_events_passes():
    day = _DAY_NO_EVENTS
    async with db_session() as db:
        await set_bypass_rls(db)
        await assert_rolled_up(db, day)  # must not raise
