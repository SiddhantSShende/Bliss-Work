-- 0009_beacon_batch_idempotency — dedup a beacon's activeMs/idleMs accrual on
-- client retry.
--
-- Migration 0006 deduped `activity_events` rows on `client_event_id`, but a
-- beacon's activeMs/idleMs are a SEPARATE write (open_or_touch's additive
-- `active_ms = active_ms + :active`) with no identity at all — nothing there
-- distinguishes "a genuinely new 30s of activity" from "the same 30s the
-- client already reported, resent because the success response never made it
-- back" (a keepalive fetch during pagehide, or any other lost ack). Every
-- retry of that kind permanently inflated the session's, and therefore the
-- day's, tracked active/idle time.
--
-- One row here means "this (org, user, client_event_id) batch's activeMs/
-- idleMs has already been applied" — checked with a plain claim insert
-- (ON CONFLICT DO NOTHING) before the accrual, so a retried batch's time is
-- silently skipped while the batch's `events` (already deduped by 0006) and
-- session touch (last_seen_at) still go through normally.
--
-- Optional like 0006's client_event_id: an older client that sends none is
-- simply never deduped here, same as before this migration.
CREATE TABLE IF NOT EXISTS beacon_batches (
    org_id          uuid NOT NULL,
    user_id         uuid NOT NULL,
    client_event_id text NOT NULL,
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id, client_event_id)
);

-- Backs the nightly prune's age scan (see app/jobs/prune.py, alongside
-- consumed_events — a claim only ever needs to outlive the client's own
-- retry window, not the platform's raw-event retention).
CREATE INDEX IF NOT EXISTS idx_beacon_batches_claimed_at ON beacon_batches (claimed_at);

ALTER TABLE beacon_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE beacon_batches FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'beacon_batches'
    ) THEN
        CREATE POLICY org_isolation ON beacon_batches
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;
