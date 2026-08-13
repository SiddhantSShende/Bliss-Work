"""Nightly prune: drop expired raw partitions, keep the rollups forever.

Runs at 04:30 UTC — after the 02:30 backup, so the most recent dump always
predates the deletion, and after the attachment GC, so the two heavy jobs do not
overlap.

The job REFUSES to run if a day it is about to drop was never rolled up. That is
the whole safety property: rollups are the only thing that survives, so dropping
a raw partition whose aggregates were never computed destroys that day
permanently and silently. Exiting non-zero makes the systemd unit go red, which
is the difference between "we noticed" and "we noticed six months later".

    python -m app.jobs.prune
    python -m app.jobs.prune --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text

from ..config import settings
from ..db import dispose_engine, init_engine, session, set_bypass_rls
from ..logging_setup import configure_logging, log

# Kafka dedup keys only need to outlive any plausible redelivery window; a week
# is far beyond it and keeps the table from growing without bound.
CONSUMED_EVENT_RETENTION_DAYS = 7
_PARTITION_PREFIX = "activity_events_"


class UnrolledDayError(RuntimeError):
    """A partition is due for deletion but its day was never rolled up."""


async def expired_partitions(db, cutoff: date) -> list[tuple[str, date]]:
    """Partitions whose day is strictly older than the cutoff, oldest first."""
    rows = (
        await db.execute(
            text(
                "SELECT c.relname FROM pg_class c "
                "JOIN pg_inherits i ON i.inhrelid = c.oid "
                "JOIN pg_class p ON p.oid = i.inhparent "
                "WHERE p.relname = 'activity_events' AND c.relkind = 'r' "
                "ORDER BY c.relname"
            )
        )
    ).all()
    out: list[tuple[str, date]] = []
    for r in rows:
        name = r.relname
        stamp = name[len(_PARTITION_PREFIX):]
        try:
            day = datetime.strptime(stamp, "%Y%m%d").date()
        except ValueError:
            # Not one of ours (a manual copy, a rename). Never drop it.
            log.warning("prune_unrecognized_partition", name=name)
            continue
        if day < cutoff:
            out.append((name, day))
    return out


async def assert_rolled_up(db, day: date) -> None:
    """Refuse to drop a day whose aggregates were never computed.

    A day with no events at all is fine — nothing to lose. A day with events but
    no rollup means the nightly job did not run, and dropping it would delete the
    only copy.
    """
    had_events = (
        await db.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM activity_events "
                "WHERE occurred_at >= :d AND occurred_at < :d2)"
            ),
            {"d": day, "d2": day + timedelta(days=1)},
        )
    ).scalar()
    if not had_events:
        return
    rolled = (
        await db.execute(
            text("SELECT EXISTS (SELECT 1 FROM activity_daily WHERE day = :d)"),
            {"d": day},
        )
    ).scalar()
    if not rolled:
        raise UnrolledDayError(
            f"{day.isoformat()} has raw events but no activity_daily rows — "
            f"run `python -m app.jobs.rollup --day={day.isoformat()}` first"
        )


async def run(dry_run: bool = False) -> int:
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=settings.raw_retention_days)
    dropped = 0

    # Keep the window ahead of "now" open BEFORE deleting anything, so a failure
    # below can never leave ingest without a partition to write to.
    #
    # Its own transaction, deliberately. `set_bypass_rls` uses
    # `set_config(..., is_local => true)`, so the GUC is reset at COMMIT — doing
    # this and then continuing in the same session would leave every subsequent
    # read fenced by RLS with no org context, i.e. returning zero rows. Here that
    # would have been silent and severe: `assert_rolled_up` would see "no events
    # on this day", conclude there was nothing to lose, and drop a partition
    # whose aggregates had never been computed.
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text("SELECT ensure_activity_partitions(:d)"),
            {"d": settings.partition_days_ahead},
        )
        await db.commit()

    async with session() as db:
        # Spans every org; maintenance work runs under bypass. Set once, and
        # nothing below commits until the very end.
        await set_bypass_rls(db)

        for name, day in await expired_partitions(db, cutoff):
            await assert_rolled_up(db, day)
            if dry_run:
                log.info("prune_would_drop", partition=name, day=day.isoformat())
                continue
            # DROP, not DELETE. This is the entire reason the table is
            # partitioned by day: reclaiming 90-day-old rows is a catalog
            # operation instead of millions of dead tuples for autovacuum to
            # chase on a Postgres shared with every other service.
            await db.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
            dropped += 1
            log.info("prune_dropped_partition", partition=name, day=day.isoformat())

        if not dry_run:
            # Sessions are not partitioned (there are orders of magnitude fewer
            # of them), so they are deleted the ordinary way.
            sessions_gone = await db.execute(
                text(
                    "DELETE FROM user_sessions WHERE ended_at IS NOT NULL "
                    "AND ended_at < now() - make_interval(days => :d)"
                ),
                {"d": settings.raw_retention_days},
            )
            consumed_gone = await db.execute(
                text(
                    "DELETE FROM consumed_events "
                    "WHERE consumed_at < now() - make_interval(days => :d)"
                ),
                {"d": CONSUMED_EVENT_RETENTION_DAYS},
            )
            await db.commit()
            log.info(
                "prune_complete",
                partitions_dropped=dropped,
                sessions_deleted=sessions_gone.rowcount,
                consumed_deleted=consumed_gone.rowcount,
                retention_days=settings.raw_retention_days,
            )
    return dropped


async def _main(dry_run: bool) -> None:
    init_engine()
    try:
        await run(dry_run)
    finally:
        await dispose_engine()


if __name__ == "__main__":
    configure_logging(settings.log_level)
    parser = argparse.ArgumentParser(description="Drop expired raw activity partitions.")
    parser.add_argument("--dry-run", action="store_true", help="report, delete nothing")
    args = parser.parse_args()
    try:
        asyncio.run(_main(args.dry_run))
    except UnrolledDayError as exc:
        # Non-zero so the systemd unit goes red. A swallowed failure here is
        # indistinguishable from a healthy system right up until someone asks
        # for a report covering the month we quietly deleted.
        log.error("prune_refused", reason=str(exc))
        sys.exit(1)
