"""Integration fixtures: the real app against a real Postgres.

Dual-mode like auth-svc's suite:
  * TEST_DATABASE_URL set → use it (CI service container / local ephemeral)
  * otherwise             → spin a throwaway Postgres via testcontainers

The app's own migrations are applied exactly as the service applies them, so the
constraints and indexes under test are the real ones. The FastAPI lifespan is
deliberately NOT run — it would start the Kafka outbox poller and the OAuth
refresh worker, neither of which this suite needs — so engine + cryptor are
initialized by hand here instead.
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
    """Note: this is a GENERATOR fixture, so every branch must `yield` — a bare
    `return dsn` here silently produces "did not yield a value"."""
    dsn = os.environ.get("TEST_DATABASE_URL")
    if dsn:
        yield dsn
        return

    from testcontainers.postgres import PostgresContainer  # lazy: only needed sans DSN

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
    """Engine + migrations + cryptor, torn down between tests."""
    from app.config import settings

    settings.integrations_database_url = database_url

    from app.crypto import init_cryptor
    from app.db import dispose_engine, get_engine, init_engine, run_migrations

    init_engine()
    await run_migrations()
    init_cryptor(settings)

    engine = get_engine()
    # Deterministic start: every org-scoped table emptied under bypass.
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
        for table in (
            "provider_activity",
            "provider_identities",
            # Before integration_connections — FK on connection_id.
            "connection_verifications",
            # Before integration_connections + provider_app_credentials: FK
            # references (oauth_states.app_credential_id, and the connection FK).
            "oauth_states",
            "integration_connections",
            "provider_app_credentials",
            "outbox",
            "webhook_events",
            "org_keys",
        ):
            await conn.execute(text(f"DELETE FROM {table}"))

    yield
    await dispose_engine()
