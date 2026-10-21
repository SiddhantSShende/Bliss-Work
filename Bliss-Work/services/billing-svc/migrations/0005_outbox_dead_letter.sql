-- Step 4 (low-credit notifications): billing-svc gets its first outbox
-- poller. Add the same dead-letter/attempt-tracking columns every other
-- poller's outbox carries (task-svc/migrations/008_outbox_dead_letter.sql,
-- sticky-svc/migrations/005_outbox.sql) — this is exactly the shape
-- services/shared/outbox_dlq operates on, and app/outbox_poller.py (added
-- alongside this migration) uses that shared module unchanged.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_error text;

-- The poller's claim: unpublished and not quarantined. Replaces
-- idx_outbox_unpublished (0001), which did not know about dead_lettered_at.
DROP INDEX IF EXISTS idx_outbox_unpublished;
CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON outbox (created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
    ON outbox (dead_lettered_at DESC)
    WHERE dead_lettered_at IS NOT NULL;
