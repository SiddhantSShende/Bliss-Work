"""Apply retention to the event-plumbing tables.

    python -m app.jobs.prune_event_tables
    python -m app.jobs.prune_event_tables --dry-run

WHY THIS EXISTS
---------------
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
        table="consumed_events",
        where="consumed_at < now() - make_interval(secs => :retention)",
        retention_seconds=30 * DAY,
        why="past Kafka's retention a redelivery cannot happen, so the row can never match",
    ),
)


if __name__ == "__main__":
    dry_run = cli(__doc__)
    sys.exit(asyncio.run(run(get_engine(), log, TARGETS, dry_run)))
