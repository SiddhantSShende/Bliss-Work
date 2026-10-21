"""Phase 6 (revised plan): per-membership renewal — trial, grace, suspend."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

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

    assert period_at(2027, 1, 31) == _utc(2027, 1, 31)
    feb = next_period(_utc(2027, 1, 31), 31)
    assert feb == _utc(2027, 2, 28)
    mar = next_period(feb, 31)
    assert mar == _utc(2027, 3, 31)


async def _seed_membership(db, org, user, *, next_renewal_at, cycle_status, monthly, pending, anchor_day=1, grace_deadline=None):
    await db.execute(
        text(
            "INSERT INTO org_membership_billing "
            "(org_id, user_id, monthly_credits, pending_monthly_credits, status, cycle_status, "
            "anchor_day, next_renewal_at, grace_deadline) "
            "VALUES (:o, :u, :m, :p, 'active', :cs, :a, :n, :gd)"
        ),
        {"o": org, "u": user, "m": monthly, "p": pending, "cs": cycle_status, "a": anchor_day, "n": next_renewal_at, "gd": grace_deadline},
    )


@pytest.mark.asyncio
async def test_not_due_membership_is_skipped(db_app):
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await _seed_membership(db, org, user, next_renewal_at=_utc(2027, 4, 1), cycle_status="active", monthly=2, pending=None)
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert outcome.status == "skipped"
    assert outcome.reason == "not_due"


@pytest.mark.asyncio
async def test_trial_renewal_charges_pending_and_promotes_to_active(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await _seed_membership(db, org, user, next_renewal_at=now, cycle_status="trial", monthly=0, pending=2, anchor_day=1)
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert (outcome.status, outcome.credits_due) == ("processed", 2)

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        row = (
            await db.execute(
                text(
                    "SELECT monthly_credits, pending_monthly_credits, cycle_status, next_renewal_at "
                    "FROM org_membership_billing WHERE org_id=:o AND user_id=:u"
                ),
                {"o": org, "u": user},
            )
        ).first()
    assert balance == 8
    assert (row[0], row[1], row[2]) == (2, None, "active")
    assert row[3] == _utc(2027, 4, 1)


@pytest.mark.asyncio
async def test_insufficient_funds_moves_to_grace_without_advancing_anchor(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 1, "test_seed")
        await _seed_membership(db, org, user, next_renewal_at=now, cycle_status="active", monthly=5, pending=None, anchor_day=1)
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert (outcome.status, outcome.credits_due) == ("insufficient_funds", 5)

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        row = (
            await db.execute(
                text("SELECT cycle_status, grace_deadline, next_renewal_at FROM org_membership_billing WHERE org_id=:o AND user_id=:u"),
                {"o": org, "u": user},
            )
        ).first()
        outbox = (await db.execute(text("SELECT payload FROM outbox WHERE topic='billing.events.v1'"))).all()
    assert balance == 1
    assert row[0] == "grace"
    assert row[1] is not None
    assert row[2] == now  # untouched
    assert any(o[0].get("kind") == "membership.grace_started" for o in outbox)


@pytest.mark.asyncio
async def test_grace_expiry_with_still_insufficient_funds_suspends(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 1, "test_seed")
        await _seed_membership(
            db, org, user, next_renewal_at=now, cycle_status="grace", monthly=5, pending=None,
            anchor_day=1, grace_deadline=now - timedelta(days=1),
        )
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert outcome.status == "suspended"

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT cycle_status, suspended_at FROM org_membership_billing WHERE org_id=:o AND user_id=:u"),
                {"o": org, "u": user},
            )
        ).first()
    assert row[0] == "suspended"
    assert row[1] is not None


@pytest.mark.asyncio
async def test_grace_recovery_renews_normally_when_funded(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await _seed_membership(
            db, org, user, next_renewal_at=now, cycle_status="grace", monthly=5, pending=None,
            anchor_day=1, grace_deadline=now + timedelta(days=3),
        )
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert outcome.status == "processed"

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT cycle_status, grace_deadline, monthly_credits FROM org_membership_billing WHERE org_id=:o AND user_id=:u"),
                {"o": org, "u": user},
            )
        ).first()
    assert (row[0], row[1], row[2]) == ("active", None, 5)


@pytest.mark.asyncio
async def test_rerun_on_same_period_is_idempotent_no_double_charge(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await _seed_membership(db, org, user, next_renewal_at=now, cycle_status="active", monthly=3, pending=None, anchor_day=1)
        await db.commit()

    async with session() as db:
        first = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert first.status == "processed"

    async with session() as db:
        await db.execute(
            text("UPDATE org_membership_billing SET next_renewal_at = :n WHERE org_id=:o AND user_id=:u"),
            {"n": now, "o": org, "u": user},
        )
        await db.commit()

    async with session() as db:
        second = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert second.status == "skipped"
    assert second.reason == "already_processed"

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
    assert balance == 7  # charged once, not twice


@pytest.mark.asyncio
async def test_concurrent_renewal_attempts_never_double_charge(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await _seed_membership(db, org, user, next_renewal_at=now, cycle_status="active", monthly=3, pending=None, anchor_day=1)
        await db.commit()

    async def attempt():
        async with session() as db:
            outcome = await run_renewal_for_membership(db, org, user, now)
            await db.commit()
            return outcome.status

    results = await asyncio.gather(attempt(), attempt())
    assert sorted(results) == ["processed", "skipped"]

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        runs = (await db.execute(text("SELECT count(*) FROM membership_renewal_runs WHERE org_id=:o"), {"o": org})).scalar()
    assert balance == 7
    assert runs == 1


@pytest.mark.asyncio
async def test_dry_run_changes_nothing(db_app):
    from app.db import session
    from app.renewal import run_due_renewals

    from app import ledger

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await _seed_membership(db, org, user, next_renewal_at=now, cycle_status="active", monthly=3, pending=None, anchor_day=1)
        await db.commit()

    outcomes = await run_due_renewals(session, now=now, dry_run=True)
    assert any(o.org_id == org and o.user_id == user and o.credits_due == 3 for o in outcomes)

    async with session() as db:
        balance = (await db.execute(text("SELECT balance FROM billing_accounts WHERE org_id=:o"), {"o": org})).scalar()
        row = (await db.execute(text("SELECT next_renewal_at FROM org_membership_billing WHERE org_id=:o AND user_id=:u"), {"o": org, "u": user})).first()
        runs = (await db.execute(text("SELECT count(*) FROM membership_renewal_runs WHERE org_id=:o"), {"o": org})).scalar()
    assert balance == 10
    assert row[0] == now
    assert runs == 0
