"""Nightly rollup: raw activity → activity_daily.

Runs at 01:30 UTC for the previous day, BEFORE the 02:30 backup, so the day's
aggregates are inside that night's dump rather than a day behind it.

These rollups are what survive the 90-day prune — they are the only reason a
year-over-year chart is possible at all — so the job is written to be safe to
re-run: every write is an upsert keyed on (org, user, day), and running it twice
for the same day produces the same rows, not doubled ones.

    python -m app.jobs.rollup --day=yesterday
    python -m app.jobs.rollup --from=2026-07-01 --to=2026-07-31
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text

from ..config import settings
from ..db import dispose_engine, init_engine, session, set_bypass_rls
from ..logging_setup import configure_logging, log

# `day` is a date, and a date only means something once you name a zone. The tz
# is applied identically here and in the UI's label ("days counted in UTC"), so
# the number an admin reads always matches the boundary it was computed on.
_TZ = settings.rollup_timezone


_SESSION_ROLLUP = text(
    f"""
    WITH day_bounds AS (
        -- Local midnight, in the configured zone, as a real instant — not a
        -- date comparison, since user_sessions.started_at/ended_at are
        -- timestamptz.
        SELECT (:day::timestamp AT TIME ZONE '{_TZ}')                    AS day_start,
               (:day::timestamp AT TIME ZONE '{_TZ}') + interval '1 day' AS day_end
    ),
    -- A session belongs to :day if ANY part of its wall-clock span overlaps
    -- it — not just the day it STARTED on. A session that opens before
    -- midnight and stays open into the next day (heartbeats don't close it)
    -- used to have its ENTIRE active_ms/idle_ms/online duration credited to
    -- the start day alone: the next day's activity_daily row could show
    -- sessions_count=0 next to a nonzero events_count for that same day,
    -- an inconsistency that never self-corrected since this table is kept
    -- forever and never recomputed.
    overlapping AS (
        SELECT
            s.org_id, s.user_id, s.active_ms, s.idle_ms,
            s.started_at,
            COALESCE(s.ended_at, s.last_seen_at) AS session_end,
            GREATEST(s.started_at, db.day_start)                       AS clipped_start,
            LEAST(COALESCE(s.ended_at, s.last_seen_at), db.day_end)    AS clipped_end
          FROM user_sessions s, day_bounds db
         WHERE s.started_at < db.day_end
           AND COALESCE(s.ended_at, s.last_seen_at) >= db.day_start
    ),
    per_session AS (
        SELECT
            org_id, user_id, active_ms, idle_ms,
            clipped_start, clipped_end,
            EXTRACT(EPOCH FROM (clipped_end - clipped_start)) * 1000 AS day_online_ms,
            -- The session's TOTAL wall-clock span, floored at 1ms to guard
            -- the division below against a session whose started_at and
            -- session_end land on the same instant.
            GREATEST(EXTRACT(EPOCH FROM (session_end - started_at)) * 1000, 1) AS total_online_ms
          FROM overlapping
    )
    INSERT INTO activity_daily (
        org_id, user_id, day, first_seen_at, last_seen_at, sessions_count,
        active_ms, idle_ms, online_ms, computed_at)
    SELECT org_id, user_id, :day,
           MIN(clipped_start), MAX(clipped_end), COUNT(*),
           -- active_ms/idle_ms have no per-instant timestamp to bucket
           -- exactly the way activity_events' by_hour does — user_sessions
           -- only ever stored running TOTALS (open_or_touch's
           -- active_ms = active_ms + :active), never when each increment
           -- happened. Prorated by this day's share of the session's total
           -- wall-clock span: the best available approximation without a
           -- schema change to record per-interval accrual, and strictly
           -- better than crediting 100% of it to a single day.
           COALESCE(SUM(active_ms * day_online_ms / total_online_ms), 0)::bigint,
           COALESCE(SUM(idle_ms   * day_online_ms / total_online_ms), 0)::bigint,
           -- online_ms is exact, not approximated: it is the actual clipped
           -- wall-clock overlap with this day, which needs no proration.
           COALESCE(SUM(day_online_ms), 0)::bigint,
           now()
      FROM per_session
     GROUP BY org_id, user_id
    ON CONFLICT (org_id, user_id, day) DO UPDATE SET
        first_seen_at  = EXCLUDED.first_seen_at,
        last_seen_at   = EXCLUDED.last_seen_at,
        sessions_count = EXCLUDED.sessions_count,
        active_ms      = EXCLUDED.active_ms,
        idle_ms        = EXCLUDED.idle_ms,
        online_ms      = EXCLUDED.online_ms,
        computed_at    = now()
    """  # noqa: S608 — _TZ is service config, never request input
)

# Events are rolled up separately from sessions because a member can generate
# activity with no session at all: every server-observed row (a task completed
# from a desktop notification, a message sent from an Electron sticky) arrives
# via Kafka carrying no session id.
#
# Each jsonb map is aggregated from its OWN pre-grouped CTE. Aggregating them in
# one pass with window functions looks tighter but is wrong: jsonb_object_agg
# raises on a duplicate key, and a single day trivially contains many rows per
# surface and per action.
_EVENT_ROLLUP = text(
    f"""
    WITH day_rows AS (
        SELECT org_id, user_id, surface, action, COALESCE(duration_ms, 0) AS ms,
               EXTRACT(HOUR FROM occurred_at AT TIME ZONE '{_TZ}')::int AS hour
          FROM activity_events
         WHERE (occurred_at AT TIME ZONE '{_TZ}')::date = :day
    ),
    totals AS (
        SELECT org_id, user_id, COUNT(*) AS events FROM day_rows GROUP BY org_id, user_id
    ),
    surfaces AS (
        SELECT org_id, user_id, jsonb_object_agg(surface, ms) AS by_surface
          FROM (SELECT org_id, user_id, surface, SUM(ms) AS ms FROM day_rows
                 WHERE surface IS NOT NULL GROUP BY org_id, user_id, surface) s
         GROUP BY org_id, user_id
    ),
    actions AS (
        SELECT org_id, user_id, jsonb_object_agg(action, n) AS by_action
          FROM (SELECT org_id, user_id, action, COUNT(*) AS n FROM day_rows
                 GROUP BY org_id, user_id, action) a
         GROUP BY org_id, user_id
    ),
    hours AS (
        SELECT org_id, user_id, jsonb_object_agg(hour::text, ms) AS by_hour
          FROM (SELECT org_id, user_id, hour, SUM(ms) AS ms FROM day_rows
                 GROUP BY org_id, user_id, hour) h
         GROUP BY org_id, user_id
    )
    INSERT INTO activity_daily (
        org_id, user_id, day, events_count, by_surface, by_action, by_hour, computed_at)
    SELECT t.org_id, t.user_id, :day, t.events,
           COALESCE(s.by_surface, '{{}}'::jsonb),
           COALESCE(a.by_action,  '{{}}'::jsonb),
           COALESCE(h.by_hour,    '{{}}'::jsonb),
           now()
      FROM totals t
      LEFT JOIN surfaces s USING (org_id, user_id)
      LEFT JOIN actions  a USING (org_id, user_id)
      LEFT JOIN hours    h USING (org_id, user_id)
    ON CONFLICT (org_id, user_id, day) DO UPDATE SET
        events_count = EXCLUDED.events_count,
        by_surface   = EXCLUDED.by_surface,
        by_action    = EXCLUDED.by_action,
        by_hour      = EXCLUDED.by_hour,
        computed_at  = now()
    """  # noqa: S608 — _TZ is service config, never request input
)


async def rollup_day(day: date) -> None:
    async with session() as db:
        # Rolls up every org from one pass, so it runs under bypass.
        await set_bypass_rls(db)
        # Sessions FIRST: it inserts the (org, user, day) row that the event
        # rollup then upserts onto. Either order is correct thanks to the
        # upserts, but this way the common path takes the INSERT branch once
        # rather than inserting and immediately updating.
        await db.execute(_SESSION_ROLLUP, {"day": day})
        await db.execute(_EVENT_ROLLUP, {"day": day})
        await db.commit()
    log.info("rollup_complete", day=day.isoformat(), timezone=_TZ)


async def _main(days: list[date]) -> None:
    init_engine()
    try:
        for d in days:
            await rollup_day(d)
    finally:
        await dispose_engine()


def _parse_days(args) -> list[date]:
    if args.day == "yesterday":
        return [datetime.now(timezone.utc).date() - timedelta(days=1)]
    if args.day:
        return [date.fromisoformat(args.day)]
    start = date.fromisoformat(args.from_)
    end = date.fromisoformat(args.to)
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


if __name__ == "__main__":
    configure_logging(settings.log_level)
    parser = argparse.ArgumentParser(description="Roll raw activity into daily aggregates.")
    parser.add_argument("--day", default=None, help="YYYY-MM-DD or 'yesterday'")
    parser.add_argument("--from", dest="from_", default=None, help="YYYY-MM-DD (backfill)")
    parser.add_argument("--to", default=None, help="YYYY-MM-DD (backfill)")
    parsed = parser.parse_args()
    if not parsed.day and not (parsed.from_ and parsed.to):
        parsed.day = "yesterday"
    asyncio.run(_main(_parse_days(parsed)))
