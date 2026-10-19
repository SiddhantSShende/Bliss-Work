from __future__ import annotations

import hashlib
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from .config import settings
from .logging_setup import log

_engine: AsyncEngine | None = None
SessionLocal: async_sessionmaker[AsyncSession] | None = None

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

# Same advisory-lock-then-ledger pattern as task-svc/auth-svc (see
# task-svc/app/db.py for the full rationale): makes concurrent-replica boot
# safe and steady-state boot a single SELECT.
MIGRATION_LOCK_KEY = "billing-svc:migrations"


def init_engine() -> AsyncEngine:
    global _engine, SessionLocal
    if _engine is None:
        _engine = create_async_engine(
            settings.sqlalchemy_url,
            echo=False,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
            pool_recycle=1800,
            connect_args=settings.sqlalchemy_connect_args,
            hide_parameters=True,
        )
        SessionLocal = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)
    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        return init_engine()
    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


async def run_migrations() -> None:
    engine = get_engine()
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    async with engine.begin() as conn:
        raw = await conn.get_raw_connection()
        apg = raw.driver_connection
        await apg.execute("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", MIGRATION_LOCK_KEY)
        await apg.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   text PRIMARY KEY,
                checksum   text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        applied = {
            r["filename"]: r["checksum"]
            for r in await apg.fetch("SELECT filename, checksum FROM schema_migrations")
        }

        ran = 0
        for f in files:
            sql = f.read_text(encoding="utf-8")
            if not sql.strip():
                continue
            checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
            previous = applied.get(f.name)
            if previous == checksum:
                continue
            if previous is not None:
                log.warning(
                    "migration_file_changed_after_apply",
                    file=f.name,
                    detail="prefer a new migration file; databases that already "
                    "applied the old version will not receive the difference",
                )
            log.info("running_migration", file=f.name)
            await apg.execute(sql)
            await apg.execute(
                """
                INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
                ON CONFLICT (filename)
                DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()
                """,
                f.name,
                checksum,
            )
            ran += 1
    log.info("migrations_complete", total=len(files), applied=ran)


def session() -> AsyncSession:
    if SessionLocal is None:
        init_engine()
    assert SessionLocal is not None
    return SessionLocal()
