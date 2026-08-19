-- 0003: remove the stored liveness beats.
--
-- `heartbeat` rows recorded that a client was still open. That fact is already
-- held by user_sessions (last_seen_at, plus the active/idle totals the same
-- beacon carries), so the row was a duplicate of something better — and at one
-- per minute per open client it was the largest single contributor to this
-- database, and a wall of identical "Active" entries between the events on a
-- member's timeline that actually say what they did.
--
-- The write path no longer produces them (app/ingest.py NON_EVENT_ACTIONS).
-- This clears what was written before that.
--
-- BYPASS IS REQUIRED, NOT OPTIONAL. activity_events is ENABLE + FORCE row-level
-- security, and FORCE applies to the table owner — which is the role running
-- this migration. Without the GUC below the policy matches nothing, both
-- statements report zero rows, and the cleanup silently does not happen.
-- SET LOCAL, so it reverts when the migration transaction commits.
SET LOCAL app.bypass_rls = 'on';

-- Unindexed on `action`, so this is one pass over the retained partitions. It
-- runs once, inside the startup migration lock, and only ever on this boot: the
-- ledger in app/db.py records the file and never replays it.
DELETE FROM activity_events WHERE action = 'heartbeat';

-- The daily rollups are kept FOREVER, long after the raw partitions above are
-- pruned, so leaving the beats in the aggregate would outlive the events by
-- years. `events_count` is decremented by the same number being removed from
-- the map: every SET expression reads the OLD row, so both see the pre-update
-- by_action and the two stay consistent with each other.
UPDATE activity_daily
   SET by_action    = by_action - 'heartbeat',
       events_count = GREATEST(events_count - COALESCE((by_action ->> 'heartbeat')::int, 0), 0)
 WHERE by_action ? 'heartbeat';
