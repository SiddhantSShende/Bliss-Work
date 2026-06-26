"""Integration-test fixtures: a real Postgres with the auth-svc schema + RLS.

Dual-mode so it runs both in CI and against a hand-started DB:
  * TEST_DATABASE_URL set  → connect to that DB (CI service container / local ephemeral).
  * otherwise               → spin a throwaway Postgres via testcontainers.

Applies the production migrations exactly as the service does (every *.sql in
migrations/, sorted), so the RLS policies under test are the real ones.
"""
from __future__ import annotations

import os
import pathlib

import asyncpg
import pytest_asyncio

MIGRATIONS = pathlib.Path(__file__).resolve().parents[2] / "migrations"
_RLS_TABLES = ("audit_log", "invites", "user_roles", "users", "org_keys", "orgs")


@pytest_asyncio.fixture
async def db():
    dsn = os.environ.get("TEST_DATABASE_URL")
    container = None
    if not dsn:
        from testcontainers.postgres import PostgresContainer  # lazy: only needed sans DSN

        container = PostgresContainer("postgres:17-alpine")
        container.start()
        dsn = (
            f"postgresql://{container.username}:{container.password}"
            f"@{container.get_container_host_ip()}:{container.get_exposed_port(5432)}/{container.dbname}"
        )

    conn = await asyncpg.connect(dsn)
    try:
        for sql_file in sorted(MIGRATIONS.glob("*.sql")):
            await conn.execute(sql_file.read_text())
        # Deterministic start: clear the RLS tables (bypass so cross-org deletes work).
        await conn.execute("SELECT set_config('app.bypass_rls', 'on', false)")
        for table in _RLS_TABLES:
            await conn.execute(f"DELETE FROM {table}")
        await conn.execute("SELECT set_config('app.bypass_rls', '', false)")
        # RLS is bypassed by SUPERUSERS even with FORCE — only owners/other roles
        # are subject to it. Prod connects as a least-priv per-service role, so we
        # create one and SET ROLE to it; otherwise the policies wouldn't apply and
        # the test would be meaningless.
        await conn.execute(
            "DO $$ BEGIN "
            "IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='rls_test') "
            "THEN CREATE ROLE rls_test NOSUPERUSER; END IF; END $$;"
        )
        await conn.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test"
        )
        await conn.execute("SET ROLE rls_test")
        yield conn
    finally:
        await conn.close()
        if container is not None:
            container.stop()
