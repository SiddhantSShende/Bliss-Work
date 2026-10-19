"""Credit ledger: atomic, idempotent grants and debits against
`billing_accounts` + append-only `credit_ledger`.

Concurrency: every mutation locks the account row with `SELECT ... FOR
UPDATE` before reading the balance, inside the caller's transaction. Two
concurrent debits against the same org therefore serialize on that row —
the second waits for the first's commit/rollback and then sees the
post-debit balance, so overspending can't happen. This also makes
`credit_ledger.balance_after` trustworthy: it is always written under the
same lock that computed it.

Idempotency: callers that may retry (the future renewal worker, a payment
webhook handler) pass `idempotency_key`. It is unique per (org_id,
idempotency_key) at the schema level (partial unique index — see
migrations/0001_billing_schema.sql), so a retried call is detected here by
re-reading the existing row rather than racing the constraint, and returns
the ORIGINAL result unchanged rather than erroring or double-applying.

All functions expect to run inside an already-open AsyncSession /
transaction (`async with session() as db: ...`); none of them commit. The
caller commits (or rolls back) the whole unit of work.
"""
from __future__ import annotations

import uuid

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class InsufficientCreditsError(Exception):
    """Raised when a debit would take an org's balance below zero."""

    def __init__(self, org_id: str, balance: int, amount: int) -> None:
        self.org_id = org_id
        self.balance = balance
        self.amount = amount
        super().__init__(f"org {org_id} has {balance} credits, cannot debit {amount}")


class LedgerEntry:
    __slots__ = (
        "id",
        "org_id",
        "delta",
        "balance_after",
        "reason",
        "reference_type",
        "reference_id",
        "idempotency_key",
    )

    def __init__(
        self,
        id: str,
        org_id: str,
        delta: int,
        balance_after: int,
        reason: str,
        reference_type: str | None,
        reference_id: str | None,
        idempotency_key: str | None,
    ) -> None:
        self.id = id
        self.org_id = org_id
        self.delta = delta
        self.balance_after = balance_after
        self.reason = reason
        self.reference_type = reference_type
        self.reference_id = reference_id
        self.idempotency_key = idempotency_key


async def _existing_entry(db: AsyncSession, org_id: str, idempotency_key: str) -> LedgerEntry | None:
    row = (
        await db.execute(
            text(
                "SELECT id, org_id, delta, balance_after, reason, reference_type, "
                "reference_id, idempotency_key FROM credit_ledger "
                "WHERE org_id = :org AND idempotency_key = :key"
            ),
            {"org": org_id, "key": idempotency_key},
        )
    ).first()
    if row is None:
        return None
    return LedgerEntry(*row)


async def _lock_or_create_account(db: AsyncSession, org_id: str) -> int:
    """Lock the account row (creating it at balance 0 if it doesn't exist yet)
    and return the current balance. Must be called inside the caller's
    transaction — the lock is released at commit/rollback."""
    row = (
        await db.execute(
            text("SELECT balance FROM billing_accounts WHERE org_id = :org FOR UPDATE"),
            {"org": org_id},
        )
    ).first()
    if row is not None:
        return int(row[0])

    # INSERT ... ON CONFLICT DO NOTHING + re-SELECT FOR UPDATE: two concurrent
    # first-touches of the same org race the INSERT, not the balance read, so
    # whichever loses the conflict still gets a correctly-locked row.
    await db.execute(
        text(
            "INSERT INTO billing_accounts (org_id, balance) VALUES (:org, 0) "
            "ON CONFLICT (org_id) DO NOTHING"
        ),
        {"org": org_id},
    )
    row = (
        await db.execute(
            text("SELECT balance FROM billing_accounts WHERE org_id = :org FOR UPDATE"),
            {"org": org_id},
        )
    ).first()
    assert row is not None
    return int(row[0])


async def _apply_delta(
    db: AsyncSession,
    org_id: str,
    delta: int,
    reason: str,
    reference_type: str | None,
    reference_id: str | None,
    idempotency_key: str | None,
) -> LedgerEntry:
    if idempotency_key is not None:
        existing = await _existing_entry(db, org_id, idempotency_key)
        if existing is not None:
            return existing

    balance = await _lock_or_create_account(db, org_id)
    new_balance = balance + delta
    if new_balance < 0:
        raise InsufficientCreditsError(org_id, balance, -delta)

    await db.execute(
        text("UPDATE billing_accounts SET balance = :b, updated_at = now() WHERE org_id = :org"),
        {"b": new_balance, "org": org_id},
    )
    entry_id = str(uuid6.uuid7())
    await db.execute(
        text(
            "INSERT INTO credit_ledger "
            "(id, org_id, delta, balance_after, reason, reference_type, reference_id, idempotency_key) "
            "VALUES (:id, :org, :delta, :balance_after, :reason, :rtype, :rid, :key)"
        ),
        {
            "id": entry_id,
            "org": org_id,
            "delta": delta,
            "balance_after": new_balance,
            "reason": reason,
            "rtype": reference_type,
            "rid": reference_id,
            "key": idempotency_key,
        },
    )
    return LedgerEntry(
        entry_id, org_id, delta, new_balance, reason, reference_type, reference_id, idempotency_key
    )


async def grant_credits(
    db: AsyncSession,
    org_id: str,
    amount: int,
    reason: str,
    *,
    reference_type: str | None = None,
    reference_id: str | None = None,
    idempotency_key: str | None = None,
) -> LedgerEntry:
    """Credit an org's balance. `amount` must be positive."""
    if amount <= 0:
        raise ValueError("grant amount must be positive")
    if not _is_uuid(org_id):
        raise ValueError("org_id must be a uuid")
    return await _apply_delta(db, org_id, amount, reason, reference_type, reference_id, idempotency_key)


async def debit_credits(
    db: AsyncSession,
    org_id: str,
    amount: int,
    reason: str,
    *,
    reference_type: str | None = None,
    reference_id: str | None = None,
    idempotency_key: str | None = None,
) -> LedgerEntry:
    """Debit an org's balance. `amount` must be positive (the delta applied is
    negative). Raises InsufficientCreditsError rather than taking the balance
    negative — the caller decides how to handle that (grace period, etc.)."""
    if amount <= 0:
        raise ValueError("debit amount must be positive")
    if not _is_uuid(org_id):
        raise ValueError("org_id must be a uuid")
    return await _apply_delta(db, org_id, -amount, reason, reference_type, reference_id, idempotency_key)


async def get_balance(db: AsyncSession, org_id: str) -> int:
    row = (
        await db.execute(
            text("SELECT balance FROM billing_accounts WHERE org_id = :org"), {"org": org_id}
        )
    ).first()
    return int(row[0]) if row is not None else 0


async def reconcile_balance(db: AsyncSession, org_id: str) -> dict:
    """Recompute the balance from the append-only ledger and compare it
    against the materialized `billing_accounts.balance`. Read-only — reports a
    mismatch, never corrects one (a correction is a deliberate ledger entry,
    not something this function should decide to make on a read path)."""
    stored_row = (
        await db.execute(
            text("SELECT balance FROM billing_accounts WHERE org_id = :org"), {"org": org_id}
        )
    ).first()
    stored = int(stored_row[0]) if stored_row is not None else 0

    computed_row = (
        await db.execute(
            text("SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE org_id = :org"),
            {"org": org_id},
        )
    ).first()
    computed = int(computed_row[0]) if computed_row is not None else 0

    return {"org_id": org_id, "stored_balance": stored, "computed_balance": computed, "matches": stored == computed}


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False
