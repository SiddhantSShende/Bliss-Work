"""Apply retention to the event-plumbing tables.

    python -m app.jobs.prune_event_tables
    python -m app.jobs.prune_event_tables --dry-run

WHY THIS EXISTS
---------------
(outbox, from migrations/005_outbox.sql, is pruned on published rows only — the
same rule as task-svc's identical table.)

consumed_events (migrations/001_init.sql) records one row per event the Kafka
consumer has ever processed, for dedup on redelivery — see app/consumer.py's
`_claim()`. Nothing ever deleted a row from it, so it grew for the life of the
deployment.

The batching/locking mechanics live in the shared `prune_events` package
(services/shared/prune_events) — this file supplies only what is specific to
sticky-svc: which tables, what retention, and where its engine/logger come
from. Retention matches task-svc's identical table: past Kafka's own topic
retention a redelivery cannot happen, so a row past that window can never be
matched again.
"""
from __future__ import annotations

import asyncio
import sys

from prune_events import DAY, Target, cli, run

from ..db import get_engine
from ..logging_setup import log

TARGETS: tuple[Target, ...] = (
    Target(
        table="outbox",
        # `published_at IS NOT NULL` is the load-bearing half: a NULL means the
        # row is still pending work, and dead_lettered_at marks the only
        # surviving copy of an event that never reached its consumers.
        where="published_at IS NOT NULL AND published_at < now() - make_interval(secs => :retention)",
        retention_seconds=7 * DAY,
        why="published rows are spent; Kafka's own retention is the replay mechanism from here",
    ),
    Target(
        table="consumed_events",
        where="consumed_at < now() - make_interval(secs => :retention)",
        retention_seconds=30 * DAY,
        why="past Kafka's retention a redelivery cannot happen, so the row can never match",
    ),
)


if __name__ == "__main__":
    dry_run = cli(__doc__)
    sys.exit(asyncio.run(run(get_engine(), log, TARGETS, dry_run)))
