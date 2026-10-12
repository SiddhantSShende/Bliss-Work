-- 0037_call_screenshare_one_per_call.sql — only one live screen share per
-- CALL, not per (call, user).
--
-- 0016_call_sharing_and_lobby.sql deliberately scoped the uniqueness to
-- (call_id, user_id): "Participants may share CONCURRENTLY with each other —
-- this bounds each person, not the room." That turned out to be the wrong
-- product rule: two participants sharing at once is the bug this migration
-- closes. idx_call_screenshares_live is replaced with a partial unique index
-- on call_id alone, which StartScreenShare's INSERT ... ON CONFLICT now
-- targets (see calls_sharing.go) to make "is anyone else already sharing"
-- an atomic, database-enforced check instead of a race two app-server
-- requests can both win.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY
-- boot, so every statement guards re-execution.

-- Collapse any shares that are concurrently live under the OLD per-user-only
-- invariant down to one per call before the new constraint can be created:
-- keep the earliest start, close the rest. A no-op on a fresh/empty table or
-- one where the invariant already holds (the common case, every second run).
WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY call_id ORDER BY started_at ASC, id ASC) AS rn
    FROM call_screenshares
    WHERE stopped_at IS NULL
)
UPDATE call_screenshares cs
SET stopped_at = now()
FROM ranked
WHERE cs.id = ranked.id AND ranked.rn > 1;

DROP INDEX IF EXISTS idx_call_screenshares_live;

-- Superseded by idx_call_screenshares_live_per_call below, which is the same
-- columns and predicate plus the uniqueness the room now needs — nothing
-- else queried this one specifically.
DROP INDEX IF EXISTS idx_call_screenshares_call;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_screenshares_live_per_call
    ON call_screenshares (call_id)
    WHERE stopped_at IS NULL;
