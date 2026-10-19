"""Ledger: atomic grants/debits, idempotency, concurrency, reconciliation."""
from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def _org() -> str:
    return str(uuid.uuid4())


@pytest.mark.asyncio
async def test_grant_then_debit_updates_balance_and_ledger(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        entry = await ledger.grant_credits(db, org, 10, "monthly_grant")
        await db.commit()
    assert entry.balance_after == 10

    async with session() as db:
        entry = await ledger.debit_credits(db, org, 4, "renewal_debit")
        await db.commit()
    assert entry.balance_after == 6

    async with session() as db:
        assert await ledger.get_balance(db, org) == 6


@pytest.mark.asyncio
async def test_debit_below_zero_raises_and_rolls_back(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 5, "monthly_grant")
        await db.commit()

    async with session() as db:
        with pytest.raises(ledger.InsufficientCreditsError):
            await ledger.debit_credits(db, org, 10, "renewal_debit")
        await db.rollback()

    async with session() as db:
        # Balance unaffected, and no ledger row was written for the failed debit.
        assert await ledger.get_balance(db, org) == 5
        count = (
            await db.execute(
                text("SELECT count(*) FROM credit_ledger WHERE org_id = :o"), {"o": org}
            )
        ).scalar()
    assert count == 1


@pytest.mark.asyncio
async def test_duplicate_grant_with_same_idempotency_key_is_a_noop(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    for _ in range(3):
        async with session() as db:
            entry = await ledger.grant_credits(
                db, org, 3, "monthly_grant", idempotency_key="period-2026-10"
            )
            await db.commit()
        assert entry.balance_after == 3

    async with session() as db:
        assert await ledger.get_balance(db, org) == 3
        count = (
            await db.execute(
                text("SELECT count(*) FROM credit_ledger WHERE org_id = :o"), {"o": org}
            )
        ).scalar()
    assert count == 1


@pytest.mark.asyncio
async def test_duplicate_debit_with_same_idempotency_key_is_a_noop(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "monthly_grant")
        await db.commit()

    for _ in range(3):
        async with session() as db:
            entry = await ledger.debit_credits(
                db, org, 4, "renewal_debit", idempotency_key="period-2026-10"
            )
            await db.commit()
        assert entry.balance_after == 6

    async with session() as db:
        assert await ledger.get_balance(db, org) == 6


@pytest.mark.asyncio
async def test_concurrent_debits_cannot_overspend(db_app):
    """Ten concurrent debits of 3 against a balance of 10: the row lock in
    _lock_or_create_account serializes them, so exactly 3 succeed (9 spent)
    and 7 fail with InsufficientCreditsError — never a negative balance."""
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "monthly_grant")
        await db.commit()

    async def attempt(i: int) -> bool:
        try:
            async with session() as db:
                await ledger.debit_credits(db, org, 3, "concurrent_test", idempotency_key=f"attempt-{i}")
                await db.commit()
            return True
        except ledger.InsufficientCreditsError:
            return False

    results = await asyncio.gather(*(attempt(i) for i in range(10)))
    succeeded = sum(1 for r in results if r)
    assert succeeded == 3

    async with session() as db:
        balance = await ledger.get_balance(db, org)
    assert balance == 1
    assert balance >= 0


@pytest.mark.asyncio
async def test_reconcile_balance_matches_after_normal_operations(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "monthly_grant")
        await ledger.debit_credits(db, org, 3, "renewal_debit")
        await db.commit()

    async with session() as db:
        result = await ledger.reconcile_balance(db, org)
    assert result["matches"] is True
    assert result["stored_balance"] == 7
    assert result["computed_balance"] == 7


@pytest.mark.asyncio
async def test_reconcile_balance_detects_drift(db_app):
    """Simulates a materialized-balance bug by writing to billing_accounts
    directly, bypassing the ledger — reconcile must flag the mismatch."""
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "monthly_grant")
        await db.commit()

    async with session() as db:
        await db.execute(
            text("UPDATE billing_accounts SET balance = 999 WHERE org_id = :o"), {"o": org}
        )
        await db.commit()

    async with session() as db:
        result = await ledger.reconcile_balance(db, org)
    assert result["matches"] is False
    assert result["stored_balance"] == 999
    assert result["computed_balance"] == 10


@pytest.mark.asyncio
async def test_rejects_non_positive_amounts(db_app):
    from app import ledger
    from app.db import session

    org = _org()
    async with session() as db:
        with pytest.raises(ValueError):
            await ledger.grant_credits(db, org, 0, "bad")
        with pytest.raises(ValueError):
            await ledger.grant_credits(db, org, -5, "bad")
        with pytest.raises(ValueError):
            await ledger.debit_credits(db, org, 0, "bad")
