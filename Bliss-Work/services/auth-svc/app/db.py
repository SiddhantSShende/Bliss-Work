"""Async SQLAlchemy engine + migration runner."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .config import settings
from .logging_config import log

engine: AsyncEngine = create_async_engine(
    settings.sqlalchemy_url,
    # 5+5, not 10+10. Across the four Python services, notification-svc,
    # messaging-svc and email-worker the old sizes summed to 121 possible
    # backends against a Postgres allowing 97 — so a burst that filled overflow
    # on three services at once produced `FATAL: sorry, too many clients
    # already`, and with a database per service there is no shared arbiter to
    # make that queue instead of fail. The sum is now 68 against max_connections
    # 200 (see docker-compose.prod.yml), which is also far closer to what 8
    # cores can actually run concurrently.
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,
    pool_recycle=1800,  # recycle pooled connections every 30 min so a DB restart
    # / maintenance window can't hand back a dead connection.
    connect_args=settings.sqlalchemy_connect_args,
)

SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    engine, expire_on_commit=False, class_=AsyncSession
)

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


async def run_migrations() -> None:
    """Execute every .sql file in migrations/ (sorted) on startup, idempotently."""
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        log.warning("no_migration_files_found", dir=str(MIGRATIONS_DIR))
    # Use the raw asyncpg connection: its simple-query protocol runs the whole
    # multi-statement .sql script in one call (SQLAlchemy text() would try a
    # single prepared statement and fail on multiple statements).
    async with engine.begin() as conn:
        raw = await conn.get_raw_connection()
        apg = raw.driver_connection
        for f in files:
            sql = f.read_text(encoding="utf-8")
            if not sql.strip():
                continue
            log.info("running_migration", file=f.name)
            await apg.execute(sql)
    log.info("migrations_complete", count=len(files))
