-- 0027_call_ends_at.sql — when a call is scheduled to be over.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── Why a call had no end ────────────────────────────────────────────────────
-- 0015 gave calls a `scheduled_at` and nothing else: a start with no length. A
-- call therefore ran until a host pressed End or walked out of it, and if
-- neither happened — the organiser's tab was closed rather than left, their
-- laptop slept, their network dropped — the row stayed LIVE indefinitely. That
-- is not only an untidy list: OnCallUserIDs derives "Busy" from the live rows,
-- so everybody still holding an open participant row on that call was reported
-- to their colleagues as being in a meeting they had left hours earlier.
--
-- `ends_at` is the clock half of the answer (call_sweeper.go is the sweeper
-- that reads it); the SFU's participant_left / room_finished webhooks are the
-- other half, and neither replaces the other. The clock closes a room nobody
-- ever joined; the webhook closes one everybody walked out of early.
--
-- NULL is a call with no scheduled end, which is every call written before this
-- migration and every ad-hoc "meet now" that names no duration. The sweeper
-- ignores those rather than inventing a length for them — guessing when a call
-- somebody is sitting in should stop is worse than leaving it to the host.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS ends_at timestamptz;

-- An end that precedes its own start is a bad request, not a state to sweep.
-- Guarded rather than bare: ADD CONSTRAINT has no IF NOT EXISTS before PG 16,
-- and this file re-runs on every boot.
DO $calls_ends_at$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'calls'::regclass AND conname = 'calls_ends_after_start'
    ) THEN
        ALTER TABLE calls ADD CONSTRAINT calls_ends_after_start
            CHECK (ends_at IS NULL OR scheduled_at IS NULL OR ends_at > scheduled_at);
    END IF;
END
$calls_ends_at$;

-- The sweeper's only query: "which calls are past their end and still open?".
-- Partial on exactly that predicate, so it stays the size of the open calls
-- rather than the size of the history — a table that only grows, swept every
-- half minute by every replica.
CREATE INDEX IF NOT EXISTS idx_calls_overdue
    ON calls (ends_at)
    WHERE ends_at IS NOT NULL AND status IN ('SCHEDULED', 'LIVE');

-- The other sweep: "which live calls has their host walked out of?". The
-- scan it drives is over LIVE calls alone, which is a handful at any moment and
-- never grows with the history beside it — without this it is a sequential scan
-- of every call ever held, every thirty seconds, in every replica.
CREATE INDEX IF NOT EXISTS idx_calls_live
    ON calls (id)
    WHERE status = 'LIVE';

-- ── Repair the rows the bug already left behind ──────────────────────────────
-- Ending a call now closes out its roster in the same transaction (endCallTx),
-- but every call that ended BEFORE this left its participants with `left_at`
-- NULL — they were, and are, recorded as still sitting in a meeting that is
-- over. The roster UI reads exactly that field, so those people show as present
-- in a call nobody is in.
--
-- `ended_at` is the honest answer to when they left: it is the last moment they
-- could still have been there. COALESCE covers a call moved to ENDED without
-- one, which no current code path writes but old rows may carry.
--
-- Bounded to calls that are already over, so it can never close out somebody
-- who is in a call right now. Idempotent by the `left_at IS NULL` guard: on
-- every boot after the first it matches nothing.
UPDATE call_participants cp
SET left_at = COALESCE(c.ended_at, now())
FROM calls c
WHERE c.id = cp.call_id
  AND c.status IN ('ENDED', 'CANCELLED')
  AND cp.joined_at IS NOT NULL
  AND cp.left_at IS NULL;
