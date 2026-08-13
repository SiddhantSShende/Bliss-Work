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


#: The least-privileged role the app connects as, mirroring production.
#:
#: This is not a detail. PostgreSQL lets a SUPERUSER bypass row-level security
#: even on a FORCE'd table, and the throwaway container's default user is one —
#: so a suite connected as that user has RLS silently switched off, and every
#: "another org cannot see this" assertion in it proves nothing. (It was caught
#: by an Embedded Signup test whose second workspace could read the first's
#: connection and then failed decrypting it under the wrong org key.)
#:
#: Migrations still run as the owner; only the APP's engine drops to this role,
#: which is exactly the split production has.
_APP_ROLE = "integrations_app_test"
_APP_PASSWORD = "app-test-pw"


def _as_role(dsn: str, role: str, password: str) -> str:
    """Swap the credentials in a postgresql:// DSN, leaving host/db intact."""
    scheme, _, rest = dsn.partition("://")
    _, _, hostpart = rest.rpartition("@")
    return f"{scheme}://{role}:{password}@{hostpart}"


@pytest_asyncio.fixture
async def db_app(database_url):
    """Engine + migrations + cryptor, torn down between tests.

    Migrations are applied as the owner, then the app engine is re-pointed at a
    least-privileged role so RLS actually applies to everything under test.
    """
    from sqlalchemy import text

    from app.config import settings

    settings.integrations_database_url = database_url

    from app.crypto import init_cryptor
    from app.db import dispose_engine, get_engine, init_engine, run_migrations

    init_engine()
    await run_migrations()

    # Create/refresh the unprivileged role and hand it table access — but NOT
    # ownership, and never BYPASSRLS.
    async with get_engine().begin() as conn:
        await conn.execute(
            text(
                f"""
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{_APP_ROLE}') THEN
                        CREATE ROLE {_APP_ROLE} LOGIN PASSWORD '{_APP_PASSWORD}';
                    END IF;
                END $$;
                """
            )
        )
        await conn.execute(text(f"GRANT USAGE ON SCHEMA public TO {_APP_ROLE}"))
        await conn.execute(
            text(
                "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public "
                f"TO {_APP_ROLE}"
            )
        )
        await conn.execute(
            text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {_APP_ROLE}")
        )
    await dispose_engine()

    settings.integrations_database_url = _as_role(database_url, _APP_ROLE, _APP_PASSWORD)
    init_engine()
    init_cryptor(settings)

    engine = get_engine()
    # Deterministic start: every org-scoped table emptied under bypass.
    from sqlalchemy import text

    async with engine.begin() as conn:
        # is_local => TRUE. With `false` this GUC is SESSION-scoped, so it stays
        # set on the pooled connection after the fixture returns — and whichever
        # request checks that connection out next runs with RLS disabled. Every
        # "another org cannot see this" assertion in the suite is only meaningful
        # with the transaction-scoped form, which is also what app/db.py uses.
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        for table in (
            "provider_activity",
            "provider_identities",
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
