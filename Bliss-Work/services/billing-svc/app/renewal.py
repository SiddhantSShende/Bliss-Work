"""Phase 5: monthly renewal — debit-only, no grace/suspension.

Billing timezone: UTC throughout. Renewal instants are always midnight UTC on
the anchor day — this sidesteps DST entirely and keeps "is it due" a plain
`<=` comparison.

Anchor: `org_billing_state.anchor_day` is the org's `orgs.created_at` day-of-
month, fixed at init and never recomputed from a clamped date. Each period's
actual renewal date is `clamp_day(year, month, anchor_day)`, so a day-31 org
renews on the 28th/29th/30th in a short month and jumps back to the 31st the
next time one is available — "retain the original anchor" per spec.

Idempotency/concurrency: `apply_membership_commitment`'s pattern reused here —
`SELECT ... FOR UPDATE` on `org_billing_state` serializes concurrent attempts
at the same org onto one winner; the loser re-reads after the winner commits
and finds the period no longer due. `billing_renewal_runs` additionally
guards by (org_id, period_start): a retried call for an already-processed
period is a no-op, not a double charge — belt-and-suspenders with the lock,
not a substitute for it (the lock also prevents double-queuing work; the
unique row prevents a double charge if two transactions ever did see the
same period as due, e.g. a crash between commit and the next poll).
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import datetime, timezone

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import ledger


def clamp_day(year: int, month: int, day: int) -> int:
    last = calendar.monthrange(year, month)[1]
    return min(day, last)


def period_at(year: int, month: int, anchor_day: int) -> datetime:
    return datetime(year, month, clamp_day(year, month, anchor_day), tzinfo=timezone.utc)


def next_period(current: datetime, anchor_day: int) -> datetime:
    total = current.month - 1 + 1
    year = current.year + total // 12
    month = total % 12 + 1
    return period_at(year, month, anchor_day)


async def ensure_org_billing_state(db: AsyncSession, org_id: str, created_at: datetime) -> None:
    """Idempotent: a later call never moves an already-initialized anchor —
    the org's first renewal date must stay fixed to its actual creation time,
    not whenever this happened to be called again."""
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    anchor_day = created_at.day
    first_due = next_period(created_at, anchor_day)
    await db.execute(
        text(
            "INSERT INTO org_billing_state (org_id, anchor_day, next_renewal_at) "
            "VALUES (:o, :a, :n) ON CONFLICT (org_id) DO NOTHING"
        ),
        {"o": org_id, "a": anchor_day, "n": first_due},
    )


@dataclass
class RenewalOutcome:
    org_id: str
    status: str  # "processed" | "insufficient_funds" | "skipped"
    credits_due: int = 0
    reason: str | None = None


async def _due_org_ids(db: AsyncSession, now: datetime) -> list[str]:
    rows = (
        await db.execute(
            text("SELECT org_id FROM org_billing_state WHERE next_renewal_at <= :now ORDER BY org_id"),
            {"now": now},
        )
    ).all()
    return [str(r[0]) for r in rows]


async def run_renewal_for_org(db: AsyncSession, org_id: str, now: datetime, *, dry_run: bool = False) -> RenewalOutcome:
    state = (
        await db.execute(
            text(
                "SELECT anchor_day, next_renewal_at FROM org_billing_state "
                "WHERE org_id = :o FOR UPDATE"
            ),
            {"o": org_id},
        )
    ).first()
    if state is None:
        return RenewalOutcome(org_id, "skipped", reason="no_billing_state")
    anchor_day, next_renewal_at = int(state[0]), state[1]
    if next_renewal_at > now:
        return RenewalOutcome(org_id, "skipped", reason="not_due")

    period_start = next_renewal_at
    period_end = next_period(period_start, anchor_day)

    already = (
        await db.execute(
            text("SELECT status, credits_due FROM billing_renewal_runs WHERE org_id = :o AND period_start = :ps"),
            {"o": org_id, "ps": period_start},
        )
    ).first()
    if already is not None:
        # Already processed this period (retry/overlap) — a prior run may have
        # crashed after this insert but before advancing org_billing_state; if
        # so, advance it now so the org is not asked about this period again.
        if not dry_run and next_renewal_at <= now:
            await db.execute(
                text("UPDATE org_billing_state SET next_renewal_at = :pe WHERE org_id = :o AND next_renewal_at = :ps"),
                {"pe": period_end, "o": org_id, "ps": period_start},
            )
        return RenewalOutcome(org_id, "skipped", credits_due=int(already[1]), reason=f"already_{already[0]}")

    members = (
        await db.execute(
            text(
                "SELECT user_id, monthly_credits, pending_monthly_credits FROM org_membership_billing "
                "WHERE org_id = :o AND status = 'active' FOR UPDATE"
            ),
            {"o": org_id},
        )
    ).all()
    charges = [(str(u), int(pending) if pending is not None else int(monthly)) for u, monthly, pending in members]
    total_due = sum(c for _, c in charges)

    if dry_run:
        return RenewalOutcome(org_id, "processed", credits_due=total_due, reason="dry_run")

    insufficient = False
    if total_due > 0:
        try:
            await ledger.debit_credits(
                db,
                org_id,
                total_due,
                reason="monthly_renewal",
                reference_type="renewal",
                reference_id=period_start.isoformat(),
                idempotency_key=f"renewal:{org_id}:{period_start.isoformat()}",
            )
        except ledger.InsufficientCreditsError:
            insufficient = True

    if insufficient:
        await db.execute(
            text(
                "INSERT INTO billing_renewal_runs (id, org_id, period_start, period_end, credits_due, status) "
                "VALUES (:id, :o, :ps, :pe, :due, 'insufficient_funds') "
                "ON CONFLICT (org_id, period_start) DO NOTHING"
            ),
            {"id": str(uuid6.uuid7()), "o": org_id, "ps": period_start, "pe": period_end, "due": total_due},
        )
        return RenewalOutcome(org_id, "insufficient_funds", credits_due=total_due)

    for user_id, cost in charges:
        await db.execute(
            text(
                "UPDATE org_membership_billing SET monthly_credits = :c, pending_monthly_credits = NULL, "
                "updated_at = now() WHERE org_id = :o AND user_id = :u"
            ),
            {"c": cost, "o": org_id, "u": user_id},
        )
    await db.execute(
        text(
            "INSERT INTO billing_renewal_runs (id, org_id, period_start, period_end, credits_due, status) "
            "VALUES (:id, :o, :ps, :pe, :due, 'processed') "
            "ON CONFLICT (org_id, period_start) DO NOTHING"
        ),
        {"id": str(uuid6.uuid7()), "o": org_id, "ps": period_start, "pe": period_end, "due": total_due},
    )
    await db.execute(
        text("UPDATE org_billing_state SET next_renewal_at = :pe, last_renewal_at = :now WHERE org_id = :o"),
        {"pe": period_end, "now": now, "o": org_id},
    )
    return RenewalOutcome(org_id, "processed", credits_due=total_due)


async def run_due_renewals(db_factory, now: datetime | None = None, *, dry_run: bool = False) -> list[RenewalOutcome]:
    """`db_factory` is `app.db.session` — a new short transaction per org, so
    one org's lock is never held while another is processed."""
    now = now or datetime.now(timezone.utc)
    async with db_factory() as db:
        org_ids = await _due_org_ids(db, now)

    outcomes: list[RenewalOutcome] = []
    for org_id in org_ids:
        async with db_factory() as db:
            outcome = await run_renewal_for_org(db, org_id, now, dry_run=dry_run)
            if dry_run:
                await db.rollback()
            else:
                await db.commit()
            outcomes.append(outcome)
    return outcomes
