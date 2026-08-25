"""Batched-delete retention runner for event-plumbing tables.

Shared across this repo's Python services (auth-svc, integrations-svc,
task-svc) so the batching/locking/reporting behavior lives in one place —
each service supplies only its own ``Target`` list, engine, and logger.

WHY IT DELETES IN BATCHES
--------------------------
One unbounded DELETE against a table with hundreds of millions of rows takes a
long transaction and a lot of locks, on tables the write path depends on.
Bounded batches with a commit between them keep each transaction short, so the
prune competes with live traffic for milliseconds at a time instead of
minutes. Slower overall, which is the correct trade for a maintenance job.
"""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text

# How many rows one transaction deletes. Small enough that locks are held
# briefly on tables the write path uses; large enough that a night's backlog
# clears in a reasonable number of round trips.
BATCH_SIZE = 10_000

# Bounds a single run so a first execution against years of history cannot run
# until morning. Hitting it is REPORTED, never silent — a truncated prune that
# looks like a completed one is how a table keeps growing while a green cron
# job says otherwise.
MAX_BATCHES = 500

# Yields to live traffic between batches. The prune is never urgent and the
# write path always is.
PAUSE_BETWEEN_BATCHES_S = 0.05

DAY = 24 * 60 * 60


@dataclass(frozen=True)
class Target:
    table: str
    # Eligibility predicate. MUST bound by age and MUST NOT match anything
    # still in use — see the per-target `why`.
    where: str
    retention_seconds: int
    why: str


class Logger(Protocol):
    """The subset of structlog's bound-logger interface this module needs —
    every service's `log` object already satisfies this structurally."""

    def info(self, event: str, **kw: object) -> None: ...
    def warning(self, event: str, **kw: object) -> None: ...
    def exception(self, event: str, **kw: object) -> None: ...


async def prune_target(engine, log: Logger, target: Target, dry_run: bool) -> None:
    params = {"retention": target.retention_seconds}

    if dry_run:
        async with engine.connect() as conn:
            n = (
                await conn.execute(
                    text(f"SELECT count(*) FROM {target.table} WHERE {target.where}"),  # noqa: S608 — fixed table list
                    params,
                )
            ).scalar_one()
        log.info(
            "prune_would_delete",
            table=target.table,
            rows=n,
            retention_days=target.retention_seconds // DAY,
            why=target.why,
        )
        return

    # Delete a bounded set selected in a CTE rather than with a bare LIMIT:
    # `DELETE ... LIMIT` is not valid Postgres, and the CTE form keeps the row
    # set stable for the duration of the statement.
    #
    # Keyed on `ctid`, the physical row address, rather than on a primary key.
    # Targets across services have different key shapes, and ctid is the one
    # identifier all of them share, so this stays a single code path.
    #
    # FOR UPDATE SKIP LOCKED so the prune never blocks, or is blocked by, a
    # poller holding rows it is mid-publish.
    stmt = text(
        f"""
        WITH doomed AS (
            SELECT ctid FROM {target.table} WHERE {target.where}
            LIMIT {BATCH_SIZE}
            FOR UPDATE SKIP LOCKED
        )
        DELETE FROM {target.table} t USING doomed d WHERE t.ctid = d.ctid
        """  # noqa: S608 — fixed table list, never user input
    )

    deleted = 0
    for _ in range(MAX_BATCHES):
        async with engine.begin() as conn:
            n = (await conn.execute(stmt, params)).rowcount or 0
        deleted += n
        if n < BATCH_SIZE:
            log.info(
                "prune_done",
                table=target.table,
                deleted=deleted,
                retention_days=target.retention_seconds // DAY,
            )
            return
        # Yield between batches so the prune interleaves with live traffic
        # rather than monopolising a connection and the table's locks.
        await asyncio.sleep(PAUSE_BETWEEN_BATCHES_S)

    # Reported, never silent — see MAX_BATCHES.
    log.warning(
        "prune_hit_batch_ceiling",
        table=target.table,
        deleted=deleted,
        max_batches=MAX_BATCHES,
        detail="rows remain; run again or raise the ceiling — the table is still growing",
    )


async def run(engine, log: Logger, targets: tuple[Target, ...], dry_run: bool) -> int:
    """Prune every target in order, disposing `engine` when done. One
    unprunable table logs and continues rather than aborting the rest."""
    failed = False
    for target in targets:
        try:
            await prune_target(engine, log, target, dry_run)
        except Exception:  # noqa: BLE001 — targets are independent
            log.exception("prune_failed", table=target.table)
            failed = True
    await engine.dispose()
    return 1 if failed else 0


def cli(description: str) -> bool:
    """Parses this job's command line and returns whether --dry-run was passed."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be deleted without deleting it",
    )
    return parser.parse_args().dry_run
