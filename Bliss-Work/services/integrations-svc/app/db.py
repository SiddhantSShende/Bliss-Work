from __future__ import annotations

from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from .config import settings
from .logging_setup import log

_engine: AsyncEngine | None = None
SessionLocal: async_sessionmaker[AsyncSession] | None = None

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def init_engine() -> AsyncEngine:
    global _engine, SessionLocal
    if _engine is None:
        _engine = create_async_engine(
            settings.sqlalchemy_url,
            echo=False,
            pool_pre_ping=True,
            # 5+5, not 10+10 — see the note in auth-svc/app/db.py. The pools
            # across all services previously summed to 121 possible backends
            # against a Postgres allowing 97; they now sum to 68 against 200.
            pool_size=5,
            max_overflow=5,
            pool_recycle=1800,  # recycle pooled conns every 30 min (avoid stale)
            connect_args=settings.sqlalchemy_connect_args,
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
    """Execute every .sql file in migrations/ in lexical order on startup."""
    engine = get_engine()
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    async with engine.begin() as conn:
        for f in files:
            sql = f.read_text(encoding="utf-8")
            log.info("running_migration", file=f.name)
            # asyncpg executes multi-statement scripts (incl. DO $$ blocks) in one call.
            raw = await conn.get_raw_connection()
            await raw.driver_connection.execute(sql)
    log.info("migrations_complete", count=len(files))


def session() -> AsyncSession:
    if SessionLocal is None:
        init_engine()
    assert SessionLocal is not None
    return SessionLocal()


# ── RLS (Row-Level Security) GUC plumbing ─────────────────────────────────────
# Every org-scoped transaction that touches an RLS-protected table (tasks,
# task_assignees, idempotency_keys, org_keys, user_projection) MUST set the org
# context as its FIRST statement, or the policy fails closed (0 rows). We use
# `set_config(..., is_local => true)` so the setting is scoped to the current
# transaction and auto-resets at commit/rollback — it can never leak across a
# pooled connection's next checkout.


async def set_org_context(db: AsyncSession, org_id: str) -> None:
    """Bind `app.org_id` for this transaction so RLS exposes only this org's rows.

    Call this FIRST, before any query (incl. encrypt/decrypt, which read/write
    the RLS-protected org_keys table in the same session).
    """
    await db.execute(
        text("SELECT set_config('app.org_id', :o, true)"),
        {"o": str(org_id)},
    )


async def set_bypass_rls(db: AsyncSession) -> None:
    """Bypass RLS for this transaction (trusted server code ONLY — never driven
    by request input).

    For: (a) pre-org-context auth flows that look up by blind index / token hash
    before the org is known, and (b) cross-org background workers (Kafka
    consumers, the outbox poller, projection upserts) that legitimately span orgs.
    """
    await db.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
