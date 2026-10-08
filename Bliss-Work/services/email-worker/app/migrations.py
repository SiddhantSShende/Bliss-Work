"""Locked, ledger-backed email-worker database migrations."""
from __future__ import annotations

import hashlib
from pathlib import Path

import asyncpg

from .logging_setup import get_logger

log = get_logger("migrations")
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_LOCK_KEY = "taskboard:email-worker:migrations"


async def run_migrations(pool: asyncpg.Pool) -> None:
    """Apply unapplied SQL migrations under the repository's DB-lock pattern."""
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
                MIGRATION_LOCK_KEY,
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    filename text PRIMARY KEY,
                    checksum text NOT NULL,
                    applied_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
            applied = {
                row["filename"]: row["checksum"]
                for row in await conn.fetch(
                    "SELECT filename, checksum FROM schema_migrations"
                )
            }
            ran = 0
            for migration in files:
                sql = migration.read_text(encoding="utf-8")
                if not sql.strip():
                    continue
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                previous = applied.get(migration.name)
                if previous == checksum:
                    continue
                if previous is not None:
                    log.warning(
                        "migration_file_changed_after_apply",
                        file=migration.name,
                        detail="prefer a new migration file; applied databases "
                        "will not receive edits to an existing migration",
                    )
                log.info("running_migration", file=migration.name)
                await conn.execute(sql)
                await conn.execute(
                    """
                    INSERT INTO schema_migrations (filename, checksum)
                    VALUES ($1, $2)
                    ON CONFLICT (filename)
                    DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()
                    """,
                    migration.name,
                    checksum,
                )
                ran += 1
    log.info("migrations_complete", total=len(files), applied=ran)
