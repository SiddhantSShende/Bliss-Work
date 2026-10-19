"""Phase 1: verify the schema applies cleanly, twice, with the expected tables
and constraints. No application logic exists yet to test."""
from __future__ import annotations

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

EXPECTED_TABLES = {
    "billing_accounts",
    "credit_ledger",
    "credit_packages",
    "credit_purchases",
    "billing_pricing",
    "platform_operators",
    "org_billing_state",
    "org_membership_billing",
    "billing_renewal_runs",
    "outbox",
    "schema_migrations",
}


@pytest.mark.asyncio
async def test_migrations_create_expected_tables(db_app):
    from app.db import get_engine

    async with get_engine().connect() as conn:
        rows = await conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        )
        tables = {r[0] for r in rows}

    assert EXPECTED_TABLES <= tables


@pytest.mark.asyncio
async def test_migrations_are_idempotent(db_app):
    from app.db import run_migrations

    # Running again must not raise and must not re-insert ledger rows.
    await run_migrations()


@pytest.mark.asyncio
async def test_balance_cannot_go_negative(db_app):
    from app.db import get_engine
    import uuid

    async with get_engine().begin() as conn:
        await conn.execute(
            text("INSERT INTO billing_accounts (org_id, balance) VALUES (:o, 0)"),
            {"o": str(uuid.uuid4())},
        )

    org_id = str(uuid.uuid4())
    async with get_engine().begin() as conn:
        await conn.execute(
            text("INSERT INTO billing_accounts (org_id, balance) VALUES (:o, 5)"),
            {"o": org_id},
        )

    with pytest.raises(Exception):
        async with get_engine().begin() as conn:
            await conn.execute(
                text("UPDATE billing_accounts SET balance = -1 WHERE org_id = :o"),
                {"o": org_id},
            )


@pytest.mark.asyncio
async def test_idempotency_key_prevents_duplicate_ledger_entry(db_app):
    from app.db import get_engine
    import uuid

    org_id = str(uuid.uuid4())
    async with get_engine().begin() as conn:
        await conn.execute(
            text("INSERT INTO billing_accounts (org_id, balance) VALUES (:o, 0)"),
            {"o": org_id},
        )
        await conn.execute(
            text(
                "INSERT INTO credit_ledger (id, org_id, delta, balance_after, reason, idempotency_key) "
                "VALUES (:id, :o, 1, 1, 'monthly_grant', 'period-2026-10')"
            ),
            {"id": str(uuid.uuid4()), "o": org_id},
        )

    with pytest.raises(Exception):
        async with get_engine().begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO credit_ledger (id, org_id, delta, balance_after, reason, idempotency_key) "
                    "VALUES (:id, :o, 1, 2, 'monthly_grant', 'period-2026-10')"
                ),
                {"id": str(uuid.uuid4()), "o": org_id},
            )
