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
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

MIGRATIONS = pathlib.Path(__file__).resolve().parents[2] / "migrations"
_RLS_TABLES = ("audit_log", "invites", "user_roles", "users", "org_keys", "orgs")


@pytest_asyncio.fixture
async def pg_dsn():
    """Resolve a migrated, RLS-ready Postgres DSN (asyncpg-style
    `postgresql://...`) — the one-time setup shared by both connection styles
    below, so it runs once per test regardless of which one that test needs."""
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
        # roles.id is still `serial` (0001_init.sql) — inserting as rls_test
        # needs nextval() on its sequence too; GRANT ... ON ALL TABLES does not
        # imply sequence privileges. (audit_log.id was also bigserial before
        # migrations/0018_audit_log_uuid_id.sql switched it to an
        # app-generated UUIDv7 like every other table's id.)
        await conn.execute(
            "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_test"
        )
    finally:
        await conn.close()
    yield dsn
    if container is not None:
        container.stop()


@pytest_asyncio.fixture
async def db(pg_dsn: str):
    conn = await asyncpg.connect(pg_dsn)
    await conn.execute("SET ROLE rls_test")
    try:
        yield conn
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def sa_conn(pg_dsn: str):
    """A SQLAlchemy `AsyncConnection` to the same migrated + RLS-ready database,
    for exercising `app.service` functions directly — they take an
    `AsyncConnection` (`text()`, `conn.execute(...)`), not an asyncpg one, and
    `db` above hands out the latter. See test_audit_context.py."""
    sa_dsn = pg_dsn.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(sa_dsn)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET ROLE rls_test"))
            yield conn
    finally:
        await engine.dispose()
