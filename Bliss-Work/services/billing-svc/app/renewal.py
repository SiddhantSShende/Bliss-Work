"""Phase 6 (revised plan): per-membership renewal — each membership has its
own trial/anchor and is charged on its own 30-day cycle, independent of any
other membership in the org.

Billing timezone: UTC throughout, same convention as before.

Anchor: `org_membership_billing.anchor_day` is set once, at trial start (see
`membership_commitment.init_membership_trial`), from the day-of-month the
trial began, and never recomputed. Each period's actual renewal date is
`clamp_day(year, month, anchor_day)` — a day-31 membership renews on the
28th/29th/30th in a short month and jumps back to the 31st the next time one
is available, same "retain the original anchor" rule as the old org-level
job (reused here unchanged, see `clamp_day`/`period_at`/`next_period`).

Idempotency/concurrency: identical pattern to the old org-level job, just
scoped to one (org_id, user_id) instead of one org_id — `SELECT ... FOR
UPDATE` on `org_membership_billing` serializes concurrent attempts at the
same membership onto one winner; `membership_renewal_runs (org_id, user_id,
period_start)` is belt-and-suspenders against a retried call double-charging.

Grace/suspension: insufficient funds at a due renewal moves the membership to
`cycle_status='grace'` with a `grace_deadline` (configurable via
`billing_pricing.grace_period_days`) instead of leaving it untouched — the
org gets a window to top up before the membership is suspended. A later pass
that finds the deadline has passed and funds are still short flips it to
`suspended`; if funds exist by then it renews normally. `org_billing_state`
and `billing_renewal_runs` (the old org-level tables) are no longer read or
written by this module — left in place as unused relics per the plan.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import ledger, outbox_helpers

BILLING_EVENTS_TOPIC = "billing.events.v1"
_DEFAULT_GRACE_PERIOD_DAYS = 7


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


async def _grace_period_days(db: AsyncSession) -> int:
    row = (
        await db.execute(text("SELECT value FROM billing_pricing WHERE key = 'grace_period_days'"))
    ).first()
    if row is None or not isinstance(row[0], (int, float)):
        # billing_pricing is seeded by migrations/0004; fall back rather than
        # fail the whole renewal pass over a missing config row.
        return _DEFAULT_GRACE_PERIOD_DAYS
    return int(row[0])


async def ensure_org_billing_state(db: AsyncSession, org_id: str, created_at: datetime) -> None:
    """Legacy org-level anchor init, kept only because `routes/internal.py`'s
    org-creation hook still calls it. `org_billing_state` is an unused relic
    under the per-membership design (nothing here reads it anymore) — this
    is populate-only, harmless bookkeeping, not part of the renewal job."""
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
    user_id: str
    status: str  # "processed" | "insufficient_funds" | "suspended" | "skipped"
    credits_due: int = 0
    reason: str | None = None


async def _due_memberships(db: AsyncSession, now: datetime) -> list[tuple[str, str]]:
    rows = (
        await db.execute(
            text(
                "SELECT org_id, user_id FROM org_membership_billing "
                "WHERE next_renewal_at <= :now AND cycle_status IN ('trial', 'active', 'grace') "
                "ORDER BY org_id, user_id"
            ),
            {"now": now},
        )
    ).all()
    return [(str(r[0]), str(r[1])) for r in rows]


async def run_renewal_for_membership(
    db: AsyncSession, org_id: str, user_id: str, now: datetime, *, dry_run: bool = False
) -> RenewalOutcome:
    row = (
        await db.execute(
            text(
                "SELECT anchor_day, next_renewal_at, cycle_status, grace_deadline, "
                "monthly_credits, pending_monthly_credits "
                "FROM org_membership_billing WHERE org_id = :o AND user_id = :u FOR UPDATE"
            ),
            {"o": org_id, "u": user_id},
        )
    ).first()
    if row is None:
        return RenewalOutcome(org_id, user_id, "skipped", reason="no_membership_billing")
    anchor_day, next_renewal_at, cycle_status, grace_deadline, monthly_credits, pending_monthly_credits = row
    if next_renewal_at > now:
        return RenewalOutcome(org_id, user_id, "skipped", reason="not_due")
    anchor_day = int(anchor_day) if anchor_day is not None else int(next_renewal_at.day)

    period_start = next_renewal_at
    period_end = next_period(period_start, anchor_day)
    cost = int(pending_monthly_credits) if pending_monthly_credits is not None else int(monthly_credits)

    already = (
        await db.execute(
            text(
                "SELECT status, credits_due FROM membership_renewal_runs "
                "WHERE org_id = :o AND user_id = :u AND period_start = :ps"
            ),
            {"o": org_id, "u": user_id, "ps": period_start},
        )
    ).first()
    if already is not None:
        # Already processed this period (retry/overlap). A prior "processed"
        # run may have crashed after this row but before advancing
        # next_renewal_at — advance it now so this membership isn't asked
        # about the same period again. A prior "insufficient_funds" run is
        # left exactly as grace/suspend handling below already left it.
        if not dry_run and already[0] == "processed" and next_renewal_at <= now:
            await db.execute(
                text(
                    "UPDATE org_membership_billing SET next_renewal_at = :pe "
                    "WHERE org_id = :o AND user_id = :u AND next_renewal_at = :ps"
                ),
                {"pe": period_end, "o": org_id, "u": user_id, "ps": period_start},
            )
        return RenewalOutcome(org_id, user_id, "skipped", credits_due=int(already[1]), reason=f"already_{already[0]}")

    if dry_run:
        return RenewalOutcome(org_id, user_id, "processed", credits_due=cost, reason="dry_run")

    grace_expired = cycle_status == "grace" and grace_deadline is not None and grace_deadline <= now

    insufficient = False
    if cost > 0:
        try:
            await ledger.debit_credits(
                db,
                org_id,
                cost,
                reason="membership_renewal",
                reference_type="membership_renewal",
                reference_id=f"{user_id}:{period_start.isoformat()}",
                idempotency_key=f"membership_renewal:{org_id}:{user_id}:{period_start.isoformat()}",
            )
        except ledger.InsufficientCreditsError:
            insufficient = True

    if insufficient:
        if grace_expired:
            await db.execute(
                text(
                    "UPDATE org_membership_billing SET cycle_status = 'suspended', suspended_at = now(), "
                    "updated_at = now() WHERE org_id = :o AND user_id = :u"
                ),
                {"o": org_id, "u": user_id},
            )
            await db.execute(
                text(
                    "INSERT INTO membership_renewal_runs (id, org_id, user_id, period_start, period_end, credits_due, status) "
                    "VALUES (:id, :o, :u, :ps, :pe, :due, 'insufficient_funds') "
                    "ON CONFLICT (org_id, user_id, period_start) DO NOTHING"
                ),
                {"id": str(uuid6.uuid7()), "o": org_id, "u": user_id, "ps": period_start, "pe": period_end, "due": cost},
            )
            await outbox_helpers.enqueue_outbox(
                db,
                BILLING_EVENTS_TOPIC,
                f"{org_id}:{user_id}",
                {"kind": "membership.suspended", "orgId": org_id, "userId": user_id, "periodStart": period_start.isoformat()},
            )
            return RenewalOutcome(org_id, user_id, "suspended", credits_due=cost)

        if cycle_status != "grace":
            grace_days = await _grace_period_days(db)
            await db.execute(
                text(
                    "UPDATE org_membership_billing SET cycle_status = 'grace', "
                    "grace_deadline = :gd, updated_at = now() WHERE org_id = :o AND user_id = :u"
                ),
                {"gd": now + timedelta(days=grace_days), "o": org_id, "u": user_id},
            )
            await outbox_helpers.enqueue_outbox(
                db,
                BILLING_EVENTS_TOPIC,
                f"{org_id}:{user_id}",
                {"kind": "membership.grace_started", "orgId": org_id, "userId": user_id, "periodStart": period_start.isoformat()},
            )
        # else: already in grace, deadline not yet passed — leave as is.
        await db.execute(
            text(
                "INSERT INTO membership_renewal_runs (id, org_id, user_id, period_start, period_end, credits_due, status) "
                "VALUES (:id, :o, :u, :ps, :pe, :due, 'insufficient_funds') "
                "ON CONFLICT (org_id, user_id, period_start) DO NOTHING"
            ),
            {"id": str(uuid6.uuid7()), "o": org_id, "u": user_id, "ps": period_start, "pe": period_end, "due": cost},
        )
        return RenewalOutcome(org_id, user_id, "insufficient_funds", credits_due=cost)

    # Success: promote pending -> current, advance the anchor, and clear any
    # trial/grace state this membership was in.
    new_cycle_status = "active" if cycle_status in ("trial", "grace") else cycle_status
    await db.execute(
        text(
            "UPDATE org_membership_billing SET monthly_credits = :c, pending_monthly_credits = NULL, "
            "cycle_status = :cs, grace_deadline = NULL, next_renewal_at = :pe, updated_at = now() "
            "WHERE org_id = :o AND user_id = :u"
        ),
        {"c": cost, "cs": new_cycle_status, "pe": period_end, "o": org_id, "u": user_id},
    )
    await db.execute(
        text(
            "INSERT INTO membership_renewal_runs (id, org_id, user_id, period_start, period_end, credits_due, status) "
            "VALUES (:id, :o, :u, :ps, :pe, :due, 'processed') "
            "ON CONFLICT (org_id, user_id, period_start) DO NOTHING"
        ),
        {"id": str(uuid6.uuid7()), "o": org_id, "u": user_id, "ps": period_start, "pe": period_end, "due": cost},
    )
    return RenewalOutcome(org_id, user_id, "processed", credits_due=cost)


async def run_due_renewals(db_factory, now: datetime | None = None, *, dry_run: bool = False) -> list[RenewalOutcome]:
    """`db_factory` is `app.db.session` — a new short transaction per
    membership, so one membership's lock is never held while another is
    processed."""
    now = now or datetime.now(timezone.utc)
    async with db_factory() as db:
        memberships = await _due_memberships(db, now)

    outcomes: list[RenewalOutcome] = []
    for org_id, user_id in memberships:
        async with db_factory() as db:
            outcome = await run_renewal_for_membership(db, org_id, user_id, now, dry_run=dry_run)
            if dry_run:
                await db.rollback()
            else:
                await db.commit()
            outcomes.append(outcome)
    return outcomes
