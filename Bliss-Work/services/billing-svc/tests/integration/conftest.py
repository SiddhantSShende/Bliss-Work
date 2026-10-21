"""Integration fixtures: migrations applied to a real Postgres.

Dual-mode, mirroring task-svc's suite: TEST_DATABASE_URL if set, otherwise a
throwaway Postgres via testcontainers. billing-svc has no RLS in phase 1, so
unlike task-svc there is no least-privileged-role switch — the app engine
connects directly.
"""
from __future__ import annotations

import os
import sys

import pytest
import pytest_asyncio

_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)


@pytest.fixture(scope="session")
def database_url():
    dsn = os.environ.get("TEST_DATABASE_URL")
    if dsn:
        yield dsn
        return

    from testcontainers.postgres import PostgresContainer

    container = PostgresContainer("postgres:17-alpine")
    container.start()
    try:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(5432)
        yield (
            f"postgresql://{container.username}:{container.password}"
            f"@{host}:{port}/{container.dbname}"
        )
    finally:
        container.stop()


@pytest_asyncio.fixture
async def db_app(database_url):
    from sqlalchemy import text

    from app.config import settings
    from app.db import dispose_engine, get_engine, init_engine, run_migrations

    settings.billing_database_url = database_url
    init_engine()
    await run_migrations()

    engine = get_engine()
    async with engine.begin() as conn:
        # billing_pricing and platform_operators are NOT per-test data — they're
        # the global config migration 0002 seeds once; wiping them here would
        # delete the seeded defaults for every test after the first.
        for table in (
            "billing_renewal_runs",
            "membership_renewal_runs",
            "org_membership_billing",
            "org_billing_state",
            "credit_purchases",
            "credit_packages",
            "credit_ledger",
            "billing_accounts",
            "outbox",
        ):
            await conn.execute(text(f"DELETE FROM {table}"))

    yield
    await dispose_engine()
