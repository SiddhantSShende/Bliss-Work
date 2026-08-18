"""Async SQLAlchemy engine + migration runner."""
from __future__ import annotations

import hashlib

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
    # make that queue instead of fail. The sum is now 68 PER REPLICA SET against
    # max_connections 200 (see docker-compose.prod.yml), which is also far closer
    # to what 8 cores can actually run concurrently.
    #
    # Multiply by the replica count before changing anything here: prod runs two
    # replicas of each of the six HTTP services, so real demand is 128, not 68.
    # Raising pool_size by 1 costs 2 backends per service at that width, and the
    # headroom left over is what absorbs psql and the exporters.
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


# Advisory-lock key for the startup migration run. Every replica of every
# service uses the same string; the lock is scoped to a database and each
# service owns its own, so they never contend with each other.
MIGRATION_LOCK_KEY = "taskboard:migrations"


async def run_migrations() -> None:
    """Execute every .sql file in migrations/ (sorted) on startup, idempotently.

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
    (which is to say, never). The same rule the rest of this codebase follows.

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
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        log.warning("no_migration_files_found", dir=str(MIGRATIONS_DIR))
    # Use the raw asyncpg connection: its simple-query protocol runs the whole
    # multi-statement .sql script in one call (SQLAlchemy text() would try a
    # single prepared statement and fail on multiple statements).
    async with engine.begin() as conn:
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
