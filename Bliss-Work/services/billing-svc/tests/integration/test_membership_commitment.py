"""Phase 4: membership-commitment gating (billing-svc side)."""
from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def _id() -> str:
    return str(uuid.uuid4())


@pytest.mark.asyncio
async def test_affordable_admin_and_member_add_succeeds(db_app):
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await db.commit()

    async with session() as db:
        ok, total, balance = await membership_commitment.apply_membership_commitment(db, org, _id(), "org_admin")
        await db.commit()
    assert (ok, total, balance) == (True, 5, 10)

    async with session() as db:
        ok, total, balance = await membership_commitment.apply_membership_commitment(db, org, _id(), "member")
        await db.commit()
    assert (ok, total, balance) == (True, 7, 10)


@pytest.mark.asyncio
async def test_unaffordable_change_is_rejected_and_writes_nothing(db_app):
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    user = _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 2, "test_seed")
        await db.commit()

    async with session() as db:
        ok, total, balance = await membership_commitment.apply_membership_commitment(db, org, user, "org_admin")
        await db.rollback()
    assert (ok, total, balance) == (False, 5, 2)

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT 1 FROM org_membership_billing WHERE org_id = :o AND user_id = :u"),
                {"o": org, "u": user},
            )
        ).first()
    assert row is None


@pytest.mark.asyncio
async def test_role_upgrade_increases_projected_commitment(db_app):
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    user = _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await db.commit()

    async with session() as db:
        ok, total, _ = await membership_commitment.apply_membership_commitment(db, org, user, "member")
        await db.commit()
    assert (ok, total) == (True, 2)

    # Upgrading the SAME user to admin must not double-count their old "member"
    # cost — apply_membership_commitment excludes this user's own existing row.
    async with session() as db:
        ok, total, _ = await membership_commitment.apply_membership_commitment(db, org, user, "org_admin")
        await db.commit()
    assert (ok, total) == (True, 5)

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT pending_monthly_credits, monthly_credits FROM org_membership_billing WHERE org_id=:o AND user_id=:u"),
                {"o": org, "u": user},
            )
        ).first()
    assert row.pending_monthly_credits == 5
    assert row.monthly_credits == 0  # untouched — only the renewal worker (later phase) advances this


@pytest.mark.asyncio
async def test_downgrade_frees_up_room_for_another_member(db_app):
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    admin_user, member_user = _id(), _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 6, "test_seed")
        await db.commit()

    async with session() as db:
        ok, _, _ = await membership_commitment.apply_membership_commitment(db, org, admin_user, "org_admin")
        await db.commit()
    assert ok is True

    # No room for a second member yet (5 + 2 > 6).
    async with session() as db:
        ok, total, balance = await membership_commitment.apply_membership_commitment(db, org, member_user, "member")
        await db.rollback()
    assert (ok, total, balance) == (False, 7, 6)

    # Downgrading the admin to member frees credits.
    async with session() as db:
        ok, total, _ = await membership_commitment.apply_membership_commitment(db, org, admin_user, "member")
        await db.commit()
    assert (ok, total) == (True, 2)

    async with session() as db:
        ok, total, _ = await membership_commitment.apply_membership_commitment(db, org, member_user, "member")
        await db.commit()
    assert (ok, total) == (True, 4)


@pytest.mark.asyncio
async def test_removal_releases_commitment_with_no_refund_and_no_ledger_entry(db_app):
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    user = _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 5, "test_seed")
        await membership_commitment.apply_membership_commitment(db, org, user, "org_admin")
        await db.commit()

    async with session() as db:
        await membership_commitment.release_membership_commitment(db, org, user)
        await db.commit()

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT status, pending_monthly_credits FROM org_membership_billing WHERE org_id=:o AND user_id=:u"),
                {"o": org, "u": user},
            )
        ).first()
        balance = await ledger.get_balance(db, org)
        ledger_count = (
            await db.execute(text("SELECT count(*) FROM credit_ledger WHERE org_id = :o"), {"o": org})
        ).scalar()
    assert (row.status, row.pending_monthly_credits) == ("removed", 0)
    assert balance == 5  # untouched — no refund
    assert ledger_count == 1  # only the original test_seed grant


@pytest.mark.asyncio
async def test_rejoin_after_removal_does_not_backcharge(db_app):
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    user = _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 3, "test_seed")
        await membership_commitment.apply_membership_commitment(db, org, user, "member")
        await db.commit()

    async with session() as db:
        await membership_commitment.release_membership_commitment(db, org, user)
        await db.commit()

    # Rejoin: a fresh commitment, not a back-charge for the gap.
    async with session() as db:
        ok, total, _ = await membership_commitment.apply_membership_commitment(db, org, user, "member")
        await db.commit()
    assert (ok, total) == (True, 2)

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT status, pending_monthly_credits, monthly_credits FROM org_membership_billing WHERE org_id=:o AND user_id=:u"),
                {"o": org, "u": user},
            )
        ).first()
    assert (row.status, row.pending_monthly_credits, row.monthly_credits) == ("active", 2, 0)


@pytest.mark.asyncio
async def test_unknown_role_is_rejected(db_app):
    from app import membership_commitment
    from app.db import session

    async with session() as db:
        with pytest.raises(membership_commitment.UnknownRoleError):
            await membership_commitment.apply_membership_commitment(db, _id(), _id(), "superuser")
        await db.rollback()


@pytest.mark.asyncio
async def test_concurrent_provisioning_never_oversubscribes_balance(db_app):
    """10 concurrent attempts to add an org_admin (5 credits each) against a
    balance of 10: the FOR UPDATE lock on billing_accounts serializes them, so
    at most 2 succeed (10 of 10 credits spent) and the rest see insufficient
    credits — never a projected total exceeding the balance."""
    from app import ledger, membership_commitment
    from app.db import session

    org = _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 10, "test_seed")
        await db.commit()

    async def attempt() -> bool:
        async with session() as db:
            ok, _, _ = await membership_commitment.apply_membership_commitment(db, org, _id(), "org_admin")
            if ok:
                await db.commit()
            else:
                await db.rollback()
            return ok

    results = await asyncio.gather(*(attempt() for _ in range(10)))
    assert sum(1 for r in results if r) == 2

    async with session() as db:
        total = (
            await db.execute(
                text(
                    "SELECT COALESCE(SUM(pending_monthly_credits),0) FROM org_membership_billing "
                    "WHERE org_id = :o AND status = 'active'"
                ),
                {"o": org},
            )
        ).scalar()
    assert total == 10
    assert total <= 10
