"""Credit enforcement for membership/role provisioning (phase 4).

This gates MEMBERSHIP CHANGES, not monthly billing: it never debits
`billing_accounts` or writes a `credit_ledger` row. It only decides whether
an org can afford the PROJECTED next-renewal commitment a change would
create, and records that projection in `org_membership_billing.
pending_monthly_credits` — the actual charge happens at renewal (a later
phase), via `monthly_credits`, which this module never touches on update.

Concurrency: `apply_membership_commitment` locks the org's `billing_accounts`
row with `SELECT ... FOR UPDATE` before computing the projected total, inside
ONE short transaction supplied by the caller (the internal route — see
app/routes/internal.py). That lock is this service's own and is released at
commit/rollback before the HTTP response is even written, so the caller
(auth-svc) never holds a network call open across a lock, and never holds
ITS OWN lock across this call either — it invokes this endpoint strictly
before opening its own transaction.

Idempotency is structural rather than key-based: the projected total always
EXCLUDES this (org_id, user_id)'s own existing row before adding the new
cost, so calling this twice with the same (org, user, role) recomputes and
writes the exact same result both times — safe to retry, no stored ledger of
past calls needed.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_ROLE_PRICING_KEYS = {
    "org_admin": "admin_monthly_credits",
    "member": "member_monthly_credits",
}


class UnknownRoleError(ValueError):
    pass


async def monthly_cost_for_role(db: AsyncSession, role: str) -> int:
    key = _ROLE_PRICING_KEYS.get(role)
    if key is None:
        raise UnknownRoleError(role)
    row = (await db.execute(text("SELECT value FROM billing_pricing WHERE key = :k"), {"k": key})).first()
    if row is None or not isinstance(row[0], (int, float)):
        # Pricing is seeded by migrations/0002_seed_default_pricing.sql; this
        # is a misconfiguration, not a normal "no price set" case — fail
        # closed (treat as unaffordable) rather than guessing a cost.
        raise UnknownRoleError(role)
    return int(row[0])


async def apply_membership_commitment(
    db: AsyncSession, org_id: str, user_id: str, role: str
) -> tuple[bool, int, int]:
    """Returns (ok, projected_total, balance). On ok=True, the commitment has
    already been written (pending_monthly_credits for this member). On
    ok=False, nothing was written — the caller must not proceed with the
    membership/role change."""
    cost = await monthly_cost_for_role(db, role)

    bal_row = (
        await db.execute(
            text("SELECT balance FROM billing_accounts WHERE org_id = :o FOR UPDATE"), {"o": org_id}
        )
    ).first()
    if bal_row is None:
        await db.execute(
            text("INSERT INTO billing_accounts (org_id, balance) VALUES (:o, 0) ON CONFLICT (org_id) DO NOTHING"),
            {"o": org_id},
        )
        bal_row = (
            await db.execute(
                text("SELECT balance FROM billing_accounts WHERE org_id = :o FOR UPDATE"), {"o": org_id}
            )
        ).first()
    balance = int(bal_row[0])

    others_total = (
        await db.execute(
            text(
                "SELECT COALESCE(SUM(COALESCE(pending_monthly_credits, monthly_credits)), 0) "
                "FROM org_membership_billing WHERE org_id = :o AND status = 'active' AND user_id <> :u"
            ),
            {"o": org_id, "u": user_id},
        )
    ).scalar()
    projected_total = int(others_total) + cost

    if projected_total > balance:
        return False, projected_total, balance

    # Trial/anchor columns are only ever set on a genuine first INSERT (a
    # brand-new (org_id, user_id) row) — the ON CONFLICT branch below never
    # touches them, so a role change or rejoin can never reset or re-grant a
    # trial. init_membership_trial is called separately, after we know
    # whether this was an insert or an update.
    existing = (
        await db.execute(
            text("SELECT 1 FROM org_membership_billing WHERE org_id = :o AND user_id = :u"),
            {"o": org_id, "u": user_id},
        )
    ).first()
    is_new_row = existing is None

    await db.execute(
        text(
            "INSERT INTO org_membership_billing (org_id, user_id, monthly_credits, pending_monthly_credits, status) "
            "VALUES (:o, :u, 0, :cost, 'active') "
            "ON CONFLICT (org_id, user_id) DO UPDATE SET "
            "pending_monthly_credits = EXCLUDED.pending_monthly_credits, status = 'active', updated_at = now()"
        ),
        {"o": org_id, "u": user_id, "cost": cost},
    )
    if is_new_row:
        await init_membership_trial(db, org_id, user_id)
    return True, projected_total, balance


async def init_membership_trial(db: AsyncSession, org_id: str, user_id: str) -> None:
    """Starts the 7-day free trial and this membership's own renewal anchor.
    Guarded by `trial_started_at IS NULL` (not just "called once at INSERT
    time") so that even if this were ever called again for the same row — a
    rejoin reusing the never-deleted row — it is a no-op and cannot grant a
    second trial or push the anchor out."""
    await db.execute(
        text(
            "UPDATE org_membership_billing SET "
            "trial_started_at = now(), "
            "trial_ends_at = now() + interval '7 days', "
            "next_renewal_at = now() + interval '7 days', "
            "cycle_status = 'trial', "
            "anchor_day = extract(day from now()) "
            "WHERE org_id = :o AND user_id = :u AND trial_started_at IS NULL"
        ),
        {"o": org_id, "u": user_id},
    )


async def release_membership_commitment(db: AsyncSession, org_id: str, user_id: str) -> None:
    """No refund, no ledger entry — this only stops the member from counting
    toward the org's PROJECTED future commitment. Idempotent (a second call
    on an already-removed row is a no-op update)."""
    await db.execute(
        text(
            "UPDATE org_membership_billing SET pending_monthly_credits = 0, status = 'removed', updated_at = now() "
            "WHERE org_id = :o AND user_id = :u"
        ),
        {"o": org_id, "u": user_id},
    )
