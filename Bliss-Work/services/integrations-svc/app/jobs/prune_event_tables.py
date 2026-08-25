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

The batching/locking mechanics live in the shared `prune_events` package
(services/shared/prune_events) — this file supplies only what is specific to
integrations-svc: which tables, what retention, and where its engine/logger
come from.
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
