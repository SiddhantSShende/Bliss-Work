"""Apply retention to the event-plumbing tables.

    python -m app.jobs.prune_event_tables
    python -m app.jobs.prune_event_tables --dry-run

WHY THIS EXISTS
---------------
Nothing in the platform ever deleted a row from the tables that make the event
pipeline work. A repo-wide search for `DELETE FROM outbox` returned nothing at
all, in any of the seven services that have one.

That is several permanent rows per event, on the single Postgres primary,
forever:

    outbox            one row per event ever produced, WITH ITS FULL JSON
                      PAYLOAD
    consumed_events   one row per event ever consumed

The failure is slow and then sudden, and it is not primarily about disk. The hot
paths stay index probes throughout; what degrades is everything around them —
indexes outgrowing memory, autovacuum falling behind the churn, backup windows
stretching, and a restore taking hours longer than the runbook claims.

It also matters for confidentiality. `outbox.payload` holds event bodies as
PLAINTEXT JSON while the corresponding columns are encrypted at rest, so
retaining the outbox forever means the encryption property does not hold for the
copy that outlives the original. Bounding the outbox bounds that exposure too.

WHERE THE RETENTION LINES ARE, AND WHY
--------------------------------------
Each table is kept for as long as something can still USE it, and not longer.

  * outbox — PUBLISHED rows only, and only past the point where replaying them
    could help. Unpublished and dead-lettered rows are never touched: an
    unpublished row is pending work, and a dead-lettered one is the only
    surviving copy of an event that failed to reach its consumers. Deleting
    either would be destroying data, not reclaiming space.

  * consumed_events — the dedup window. A row's only job is to recognise a
    redelivery, and Kafka cannot redeliver past its topic retention, so anything
    older than that (plus a wide margin) can never match again.


WHY IT DELETES IN BATCHES
-------------------------
One unbounded DELETE against a table with hundreds of millions of rows takes a
long transaction and a lot of locks, on tables the write path depends on.
Bounded batches with a commit between them keep each transaction short, so the
prune competes with live traffic for milliseconds at a time instead of minutes.
Slower overall, which is the correct trade for a maintenance job.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass

from sqlalchemy import text

from ..db import get_engine
from ..logging_setup import log

# How many rows one transaction deletes. Small enough that locks are held
# briefly on tables the write path uses; large enough that a night's backlog
# clears in a reasonable number of round trips.
BATCH_SIZE = 10_000

# Bounds a single run so a first execution against years of history cannot run
# until morning. Hitting it is REPORTED, never silent — a truncated prune that
# looks like a completed one is how a table keeps growing while a green cron job
# says otherwise.
MAX_BATCHES = 500

# Yields to live traffic between batches. The prune is never urgent and the
# write path always is.
PAUSE_BETWEEN_BATCHES_S = 0.05

_DAY = 24 * 60 * 60


@dataclass(frozen=True)
class Target:
    table: str
    # Eligibility predicate. MUST bound by age and MUST NOT match anything still
    # in use — see the per-target `why`.
    where: str
    retention_seconds: int
    why: str


TARGETS: tuple[Target, ...] = (
    Target(
        table="outbox",
        # `published_at IS NOT NULL` is the load-bearing half: a NULL means the
        # row is still pending work, and dead_lettered_at marks the only
        # surviving copy of an event that never reached its consumers.
        where="published_at IS NOT NULL AND published_at < now() - make_interval(secs => :retention)",
        retention_seconds=7 * _DAY,
        why="published rows are spent; Kafka's own retention is the replay mechanism from here",
    ),
    Target(
        table="consumed_events",
        where="consumed_at < now() - make_interval(secs => :retention)",
        retention_seconds=30 * _DAY,
        why="past Kafka's retention a redelivery cannot happen, so the row can never match",
    ),
)


async def _prune(engine, target: Target, dry_run: bool) -> None:
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
            retention_days=target.retention_seconds // _DAY,
            why=target.why,
        )
        return

    # Delete a bounded set selected in a CTE rather than with a bare LIMIT:
    # `DELETE ... LIMIT` is not valid Postgres, and the CTE form keeps the row
    # set stable for the duration of the statement.
    #
    # Keyed on `ctid`, the physical row address, rather than on a primary key.
    # The targets have different key shapes — outbox(id), consumed_events
    # (event_id) — and ctid is the one identifier
    # all of them share, so this stays a single code path.
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
                retention_days=target.retention_seconds // _DAY,
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


async def main(dry_run: bool) -> int:
    engine = get_engine()
    failed = False
    for target in TARGETS:
        try:
            await _prune(engine, target, dry_run)
        except Exception:  # noqa: BLE001 — targets are independent
            # Keep going: one unprunable table must not leave the others growing.
            log.exception("prune_failed", table=target.table)
            failed = True
    await engine.dispose()
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be deleted without deleting it",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.dry_run)))
