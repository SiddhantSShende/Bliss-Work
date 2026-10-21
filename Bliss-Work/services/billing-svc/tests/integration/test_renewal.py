"""Phase 5: monthly renewal job — debit-only, no grace/suspension."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def _id() -> str:
    return str(uuid.uuid4())


def _utc(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_anchor_clamps_on_short_months_and_restores_on_long_ones(db_app):
    from app.renewal import next_period, period_at

    # Created on the 31st: Jan 31 -> Feb (clamped 28, non-leap) -> Mar 31 (restored).
    assert period_at(2027, 1, 31) == _utc(2027, 1, 31)
    feb = next_period(_utc(2027, 1, 31), 31)
    assert feb == _utc(2027, 2, 28)
    mar = next_period(feb, 31)
    assert mar == _utc(2027, 3, 31)


@pytest.mark.asyncio
async def test_anchor_29_in_leap_year_keeps_feb_29(db_app):
    from app.renewal import next_period

    # Created Jan 29, 2028 (leap). Feb 2028 has 29 days -> no clamp needed.
    feb = next_period(_utc(2028, 1, 29), 29)
    assert feb == _utc(2028, 2, 29)
    # The following year (2029, not leap) clamps back to the 28th.
    next_jan = next_period(_utc(2029, 1, 29), 29)
    assert next_jan == _utc(2029, 2, 28)


@pytest.mark.asyncio
async def test_ensure_org_billing_state_sets_first_renewal_and_is_idempotent(db_app):
    from app.db import session
    from app.renewal import ensure_org_billing_state

    org = _id()
    created = _utc(2027, 1, 15)
    async with session() as db:
        await ensure_org_billing_state(db, org, created)
        await db.commit()
    async with session() as db:
        row = (await db.execute(text("SELECT anchor_day, next_renewal_at FROM org_billing_state WHERE org_id=:o"), {"o": org})).first()
    assert (row[0], row[1]) == (15, _utc(2027, 2, 15))

    # A second call (retry) must not move an already-set anchor.
    async with session() as db:
        await ensure_org_billing_state(db, org, _utc(2030, 6, 1))
        await db.commit()
    async with session() as db:
        row2 = (await db.execute(text("SELECT anchor_day, next_renewal_at FROM org_billing_state WHERE org_id=:o"), {"o": org})).first()
    assert (row2[0], row2[1]) == (15, _utc(2027, 2, 15))


async def _seed_org(db, org, now, *, balance, members):
    from app import ledger
    from app.renewal import ensure_org_billing_state

    await ensure_org_billing_state(db, org, now)
    await db.execute(text("UPDATE org_billing_state SET next_renewal_at = :n WHERE org_id = :o"), {"n": now, "o": org})
    if balance:
        await ledger.grant_credits(db, org, balance, "test_seed")
    for user_id, monthly, pending, status in members:
        await db.execute(
            text(
                "INSERT INTO org_membership_billing (org_id, user_id, monthly_credits, pending_monthly_credits, status) "
                "VALUES (:o, :u, :m, :p, :s)"
            ),
            {"o": org, "u": user_id, "m": monthly, "p": pending, "s": status},
        )


@pytest.mark.asyncio
async def test_not_due_org_is_skipped(db_app):
    from app.db import session
    from app.renewal import run_renewal_for_org

    org = _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await _seed_org(db, org, _utc(2027, 4, 1), balance=10, members=[])
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_org(db, org, now)
        await db.commit()
    assert outcome.status == "skipped"
    assert outcome.reason == "not_due"


@pytest.mark.asyncio
async def test_due_org_charges_monthly_credits_promotes_pending_and_advances_anchor(db_app):
    from app.db import session
    from app.renewal import run_renewal_for_org

    org = _id()
    now = _utc(2027, 3, 1)
    admin, member = _id(), _id()
    async with session() as db:
        # admin: already-committed 3; member: still pending at 1 (first renewal).
        await _seed_org(
            db, org, now, balance=10,
            members=[(admin, 3, None, "active"), (member, 0, 1, "active")],
        )
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_org(db, org, now)
        await db.commit()
    assert (outcome.status, outcome.credits_due) == ("processed", 4)

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        member_row = (await db.execute(text("SELECT monthly_credits, pending_monthly_credits FROM org_membership_billing WHERE org_id=:o AND user_id=:u"), {"o": org, "u": member})).first()
        state = (await db.execute(text("SELECT next_renewal_at, last_renewal_at FROM org_billing_state WHERE org_id=:o"), {"o": org})).first()
    assert balance == 6
    assert (member_row[0], member_row[1]) == (1, None)
    assert state[0] == _utc(2027, 4, 1)
    assert state[1] is not None


@pytest.mark.asyncio
async def test_removed_member_is_not_charged(db_app):
    from app.db import session
    from app.renewal import run_renewal_for_org

    org = _id()
    now = _utc(2027, 3, 1)
    active, removed = _id(), _id()
    async with session() as db:
        await _seed_org(
            db, org, now, balance=10,
            members=[(active, 1, None, "active"), (removed, 3, None, "removed")],
        )
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_org(db, org, now)
        await db.commit()
    assert outcome.credits_due == 1


@pytest.mark.asyncio
async def test_insufficient_balance_records_outcome_without_charging_or_suspending(db_app):
    from app.db import session
    from app.renewal import run_renewal_for_org

    org = _id()
    now = _utc(2027, 3, 1)
    admin = _id()
    async with session() as db:
        await _seed_org(db, org, now, balance=1, members=[(admin, 3, None, "active")])
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_org(db, org, now)
        await db.commit()
    assert (outcome.status, outcome.credits_due) == ("insufficient_funds", 3)

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        state = (await db.execute(text("SELECT next_renewal_at, status FROM org_billing_state WHERE org_id=:o"), {"o": org})).first()
        member_row = (await db.execute(text("SELECT monthly_credits, status FROM org_membership_billing WHERE org_id=:o AND user_id=:u"), {"o": org, "u": admin})).first()
    # Untouched: balance unchanged, anchor NOT advanced, member still active at its old monthly_credits.
    assert balance == 1
    assert state[0] == now
    assert state[1] == "active"
    assert member_row == (3, "active")


@pytest.mark.asyncio
async def test_rerun_on_same_period_is_idempotent_no_double_charge(db_app):
    from app.db import session
    from app.renewal import run_renewal_for_org

    org = _id()
    now = _utc(2027, 3, 1)
    admin = _id()
    async with session() as db:
        await _seed_org(db, org, now, balance=10, members=[(admin, 3, None, "active")])
        await db.commit()

    async with session() as db:
        first = await run_renewal_for_org(db, org, now)
        await db.commit()
    assert first.status == "processed"

    # Simulate a retried/overlapping run that somehow still saw this period as
    # due (e.g. a crash mid-way on a different replica) — must not re-debit.
    async with session() as db:
        await db.execute(text("UPDATE org_billing_state SET next_renewal_at = :n WHERE org_id=:o"), {"n": now, "o": org})
        await db.commit()

    async with session() as db:
        second = await run_renewal_for_org(db, org, now)
        await db.commit()
    assert second.status == "skipped"
    assert second.reason == "already_processed"

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
    assert balance == 7  # charged once, not twice


@pytest.mark.asyncio
async def test_concurrent_renewal_attempts_never_double_charge(db_app):
    """Two 'job instances' race the same due org; the FOR UPDATE lock on
    org_billing_state serializes them, so the loser re-reads a now-advanced
    next_renewal_at and skips rather than charging a second time."""
    from app.db import session
    from app.renewal import run_renewal_for_org

    org = _id()
    now = _utc(2027, 3, 1)
    admin = _id()
    async with session() as db:
        await _seed_org(db, org, now, balance=10, members=[(admin, 3, None, "active")])
        await db.commit()

    async def attempt():
        async with session() as db:
            outcome = await run_renewal_for_org(db, org, now)
            await db.commit()
            return outcome.status

    results = await asyncio.gather(attempt(), attempt())
    assert sorted(results) == ["processed", "skipped"]

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        runs = (await db.execute(text("SELECT count(*) FROM billing_renewal_runs WHERE org_id=:o"), {"o": org})).scalar()
    assert balance == 7
    assert runs == 1


@pytest.mark.asyncio
async def test_dry_run_changes_nothing(db_app):
    from app.db import session
    from app.renewal import run_due_renewals

    org = _id()
    now = _utc(2027, 3, 1)
    admin = _id()
    async with session() as db:
        await _seed_org(db, org, now, balance=10, members=[(admin, 3, None, "active")])
        await db.commit()

    outcomes = await run_due_renewals(session, now=now, dry_run=True)
    assert any(o.org_id == org and o.credits_due == 3 for o in outcomes)

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        state = (await db.execute(text("SELECT next_renewal_at FROM org_billing_state WHERE org_id=:o"), {"o": org})).first()
        runs = (await db.execute(text("SELECT count(*) FROM billing_renewal_runs WHERE org_id=:o"), {"o": org})).scalar()
    assert balance == 10
    assert state[0] == now
    assert runs == 0
