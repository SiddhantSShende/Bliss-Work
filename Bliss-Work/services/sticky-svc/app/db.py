from __future__ import annotations

import hashlib

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


# Advisory-lock key for the startup migration run. Every replica of this
# service uses the same string; the lock is scoped to a database and this
# service owns stickydb outright, so it never contends with anyone else. The
# name is still service-specific so a shared-database misconfiguration shows up
# as contention rather than as two services silently migrating each other.
MIGRATION_LOCK_KEY = "taskboard:sticky:migrations"


async def run_migrations() -> None:
    """Execute every .sql file in migrations/ in lexical order on startup.

    ── Why this takes a lock ────────────────────────────────────────────────
    Every replica runs this on boot, and idempotent DDL is NOT the same thing
    as concurrency-safe DDL. Two pods issuing `CREATE INDEX IF NOT EXISTS`
    against the same relation do not both quietly no-op — they take conflicting
    locks, and one dies with a deadlock or `tuple concurrently updated`, which
    crash-loops the pod. Rolling deploys and HPA scale-ups start pods together
    BY DESIGN, so this is the ordinary case rather than a race needing bad luck.

    `pg_advisory_xact_lock` makes the second pod wait and then find every
    migration already applied. Transaction-scoped, never the session variant,
    for two reasons: it releases at commit with no cleanup path to get wrong,
    and it stays correct under PgBouncer transaction pooling, where a
    session-level lock would be taken on one backend and released on another
    (which is to say, never).

    ── Why there is now a ledger ────────────────────────────────────────────
    This used to execute EVERY file on EVERY boot and rely on the SQL being
    idempotent. That works, and it is not free:

      * Idempotent DDL is not free DDL. `ALTER TABLE ... ADD COLUMN IF NOT
        EXISTS` still takes an ACCESS EXCLUSIVE lock on the table before
        deciding to do nothing, on every pod start; live queries queue behind
        it.
      * The whole run is serialised behind the advisory lock above, so N pods
        starting together cost N x the entire DDL suite. Rolling deploys and
        HPA scale-ups start pods together BY DESIGN, so boot time degraded
        exactly when capacity was most needed.
      * Boot time grew with the migration count, forever.

    The ledger makes a steady-state boot a single SELECT. The lock and the
    single transaction stay: they are what make a first boot, or a boot with
    genuine work to do, safe against a concurrent pod.

    Backfill is deliberately trivial. On the first boot after this ships the
    ledger is empty, so every file runs exactly as it always has and is then
    recorded — one more full run, and never again.
    """
    engine = get_engine()
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    async with engine.begin() as conn:
        # asyncpg executes multi-statement scripts (incl. DO $$ blocks) in one
        # call. Resolved once here rather than per file — it is the same
        # connection every time.
        raw = await conn.get_raw_connection()
        apg = raw.driver_connection
        # FIRST statement in the transaction, before any DDL is attempted.
        await apg.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", MIGRATION_LOCK_KEY
        )
        # The ledger itself. Created inside the same lock and transaction as
        # everything else, so two pods racing a first boot cannot both make it.
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
                # Re-runs, which is exactly what happened before this ledger
                # existed, so behaviour is unchanged. What is new is that it is
                # no longer SILENT: editing an applied migration is nearly
                # always a mistake, because the change never reaches databases
                # that already ran it.
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


# ── RLS (Row-Level Security) GUC plumbing ─────────────────────────────────────
# Every org-scoped transaction that touches sticky_pins MUST set the org
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
