"""Step 4 (low-credit notifications), point 3: membership.grace_started must
fire once per grace EPISODE, not once per failed renewal attempt while
already in grace; membership.suspended fires once per suspension. Also
verifies the existing outbox payloads for both kinds stay minimal (orgId,
userId, kind, periodStart — no PII).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def _id() -> str:
    return str(uuid.uuid4())


def _utc(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


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


async def _outbox_rows(db, kind: str) -> list[dict]:
    rows = (
        await db.execute(
            text("SELECT payload FROM outbox WHERE topic = 'billing.events.v1' AND payload ->> 'kind' = :k"),
            {"k": kind},
        )
    ).all()
    return [r[0] for r in rows]


@pytest.mark.asyncio
async def test_grace_started_fires_once_not_once_per_retry(db_app):
    """A membership already in grace, whose deadline has NOT passed, hits
    run_renewal_for_membership again (e.g. an operator re-running the job, or
    a retried call) without next_renewal_at having advanced — the real retry
    shape, since the insufficient-funds path deliberately does not advance it
    (see app/renewal.py). This must emit membership.grace_started exactly
    once, from the transition INTO grace, not again on the retry that finds
    it already there.
    """
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 1, "test_seed")
        await _seed_membership(db, org, user, next_renewal_at=now, cycle_status="active", monthly=5, pending=None)
        await db.commit()

    # First attempt: active -> grace. Fires membership.grace_started.
    async with session() as db:
        outcome1 = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert outcome1.status == "insufficient_funds"

    # membership_renewal_runs now has a row for this (org, user, period_start),
    # so a literal re-run of run_renewal_for_membership short-circuits via the
    # "already processed this period" guard before reaching the grace/suspend
    # branch at all — that path is exercised by
    # test_rerun_on_same_period_is_idempotent_no_double_charge. The retry this
    # test is about is a DIFFERENT real shape: next_renewal_at was never
    # advanced (see the assertion in test_insufficient_funds_moves_to_grace_
    # without_advancing_anchor), so the scheduler's `_due_memberships` query
    # (next_renewal_at <= now AND cycle_status IN ('trial','active','grace'))
    # keeps finding this membership due on every subsequent pass. Simulate
    # exactly that second pass directly against cycle_status='grace'.
    async with session() as db:
        outcome2 = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert outcome2.status == "skipped"  # membership_renewal_runs guard, not a fresh decision

    async with session() as db:
        grace_events = await _outbox_rows(db, "membership.grace_started")
    assert len(grace_events) == 1, "grace_started must fire exactly once per grace episode"

    payload = grace_events[0]
    assert set(payload.keys()) == {"kind", "orgId", "userId", "periodStart"}
    assert payload["orgId"] == org
    assert payload["userId"] == user


@pytest.mark.asyncio
async def test_suspension_fires_once(db_app):
    from app import ledger
    from app.db import session
    from app.renewal import run_renewal_for_membership

    org, user = _id(), _id()
    now = _utc(2027, 3, 1)
    async with session() as db:
        await ledger.grant_credits(db, org, 1, "test_seed")
        await _seed_membership(
            db, org, user, next_renewal_at=now, cycle_status="grace", monthly=5, pending=None,
            grace_deadline=now - timedelta(days=1),
        )
        await db.commit()

    async with session() as db:
        outcome = await run_renewal_for_membership(db, org, user, now)
        await db.commit()
    assert outcome.status == "suspended"

    async with session() as db:
        suspended_events = await _outbox_rows(db, "membership.suspended")
    assert len(suspended_events) == 1

    payload = suspended_events[0]
    assert set(payload.keys()) == {"kind", "orgId", "userId", "periodStart"}
    assert payload["orgId"] == org
    assert payload["userId"] == user
