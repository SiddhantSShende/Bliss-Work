"""Step 4 (low-credit notifications): membership.low_balance dedup/reset.

See app/ledger.py's _sync_low_balance_alert and
migrations/0006_low_balance_alert_state.sql.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def _org() -> str:
    return str(uuid.uuid4())


async def _low_balance_rows(db, org: str) -> list[dict]:
    rows = (
        await db.execute(
            text(
                "SELECT payload FROM outbox WHERE topic = 'billing.events.v1' "
                "AND payload ->> 'kind' = 'membership.low_balance' AND payload ->> 'orgId' = :o "
                "ORDER BY created_at"
            ),
            {"o": org},
        )
    ).all()
    return [r[0] for r in rows]


@pytest.mark.asyncio
async def test_crossing_threshold_emits_low_balance_once(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 25, "monthly_grant")  # above the default threshold (20)
        await db.commit()

    async with session() as db:
        # 25 -> 5, crosses below the threshold.
        await ledger.debit_credits(db, org, 20, "renewal_debit")
        await db.commit()

    async with session() as db:
        rows = await _low_balance_rows(db, org)
    assert len(rows) == 1
    assert rows[0]["balance"] == 5


@pytest.mark.asyncio
async def test_no_duplicate_same_day_while_still_below_threshold(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 25, "monthly_grant")
        await db.commit()

    # Two separate debits, same (test) day, balance stays under threshold both times.
    async with session() as db:
        await ledger.debit_credits(db, org, 20, "renewal_debit")  # 25 -> 5
        await db.commit()
    async with session() as db:
        await ledger.debit_credits(db, org, 2, "feature_usage")  # 5 -> 3, still below
        await db.commit()

    async with session() as db:
        rows = await _low_balance_rows(db, org)
    assert len(rows) == 1, "a second debit the same day, still under threshold, must not re-fire"


@pytest.mark.asyncio
async def test_topup_above_threshold_rearms_immediate_re_alert(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 25, "monthly_grant")
        await db.commit()

    async with session() as db:
        await ledger.debit_credits(db, org, 20, "renewal_debit")  # 25 -> 5: fires #1
        await db.commit()

    async with session() as db:
        await ledger.grant_credits(db, org, 100, "credit_purchase")  # 5 -> 105: back above threshold
        await db.commit()

    async with session() as db:
        await ledger.debit_credits(db, org, 90, "renewal_debit")  # 105 -> 15: dips below again
        await db.commit()

    async with session() as db:
        rows = await _low_balance_rows(db, org)
    # Re-armed by the top-up, so the second dip fires again THE SAME DAY —
    # it does not wait for a new calendar day.
    assert len(rows) == 2
    assert [r["balance"] for r in rows] == [5, 15]


@pytest.mark.asyncio
async def test_balance_at_or_above_threshold_never_alerts(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 50, "monthly_grant")
        await db.commit()
    async with session() as db:
        await ledger.debit_credits(db, org, 10, "renewal_debit")  # 50 -> 40, still well above threshold
        await db.commit()

    async with session() as db:
        rows = await _low_balance_rows(db, org)
    assert rows == []
