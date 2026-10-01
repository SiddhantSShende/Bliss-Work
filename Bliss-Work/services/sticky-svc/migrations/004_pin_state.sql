-- 004_pin_state — the user's own pin/unpin choice, stored next to (and kept
-- apart from) the task lifecycle.
--
-- ── Two independent axes on one row ──────────────────────────────────────────
-- sticky_pins already is the per-(org, user, task) record, with a unique key on
-- exactly that, so the user's choice lives here rather than in a second table
-- that would have to be kept in step with it.
--
--   status     OPEN | CLOSED        LIFECYCLE. Written ONLY by the Kafka consumer:
--                                   a terminal task status closes it, a (re)assign
--                                   opens it. A user can never write it.
--   pin_state  PINNED | UNPINNED    USER INTENT. Written ONLY by PUT/DELETE
--                                   /sticky/pins/{task}, and reset to PINNED only
--                                   when a task is assigned afresh (see
--                                   app/transitions.py). The consumer never flips it
--                                   in any other case — an acknowledgement or a
--                                   redelivered event must not undo an Unpin.
--
-- A note belongs on screen iff status = 'OPEN' AND pin_state = 'PINNED'. Keeping
-- the axes apart is the whole point: collapsing them into one column is what made
-- "the user unpinned it" indistinguishable from "the task finished" and forced the
-- old, permanent, client-side veto.
--
-- Existing rows default to PINNED, which is exactly how every open pin behaved
-- before this migration (no server-side unpin existed).
ALTER TABLE sticky_pins
    ADD COLUMN IF NOT EXISTS pin_state text NOT NULL DEFAULT 'PINNED';

-- When pin_state last CHANGED. Set to now() on a backfilled row (the real moment
-- is unknowable and the value is only used to order a client's own updates).
ALTER TABLE sticky_pins
    ADD COLUMN IF NOT EXISTS pin_state_updated_at timestamptz NOT NULL DEFAULT now();

-- ADD CONSTRAINT has no IF NOT EXISTS; guard it so a re-run (run_migrations
-- re-execs a file whose checksum changed) does not fail.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'sticky_pins_pin_state_chk'
           AND conrelid = 'sticky_pins'::regclass
    ) THEN
        ALTER TABLE sticky_pins
            ADD CONSTRAINT sticky_pins_pin_state_chk
            CHECK (pin_state IN ('PINNED', 'UNPINNED'));
    END IF;
END $$;
