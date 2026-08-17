-- 008_outbox_dead_letter.sql — stop one bad row from stopping every event.
--
-- ── The failure this removes ─────────────────────────────────────────────────
-- The poller claimed `ORDER BY created_at LIMIT n ... FOR UPDATE SKIP LOCKED`
-- and produced the batch. Any publish failure left every row unpublished, so
-- the next tick re-claimed the SAME rows — the same head of the queue, the same
-- failure, forever. There was no attempt counter, no quarantine and no alert.
--
-- That is correct for a TRANSIENT failure, which is what the design assumed: a
-- broker blip clears and the batch drains. It is fatal for a PERMANENT one. A
-- row larger than the broker's message limit can never be published, so it sat
-- at the head of the queue and every event behind it stopped with it, for every
-- organisation, indefinitely. Recovery meant a human finding and deleting it.
--
-- ── What these columns do ────────────────────────────────────────────────────
-- `publish_attempts` counts failed drains so a row that cannot be sent is
-- eventually recognised rather than retried indefinitely. `dead_lettered_at`
-- takes it out of the queue and `publish_error` records why, so the row can be
-- diagnosed and — once the cause is fixed — replayed by clearing the column.
--
-- Rows are quarantined, never deleted. An event that failed to publish is the
-- only remaining copy of something a consumer was supposed to see.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_attempts  integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dead_lettered_at  timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_error     text;

-- The claim index has to carry the quarantine predicate, or the poller keeps
-- reading dead rows and skipping them in Python — which is the same
-- head-of-line stall wearing a different hat once enough accumulate.
CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON outbox (created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- Answers "is anything stuck right now" in one index-only scan.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
    ON outbox (dead_lettered_at DESC)
    WHERE dead_lettered_at IS NOT NULL;

-- ── Retention support ────────────────────────────────────────────────────────
--
-- Nothing ever deleted from these tables — `DELETE FROM outbox` appears nowhere
-- in the repository, in any of the seven services that have one — so they hold
-- one row per event ever produced or consumed, WITH THE FULL JSON PAYLOAD, for
-- the life of the deployment. That is unbounded growth on the single Postgres
-- primary that no amount of sharding removes; sharding multiplies it.
--
-- These are the indexes the retention job's predicates need. Without them the
-- prune is a sequential scan over the very table whose size is the problem,
-- which is how a retention job becomes the incident it was added to prevent.
--
-- The outbox index is partial on `published_at IS NOT NULL`, the exact
-- complement of the claim index: together they cover the table with no overlap,
-- and the prune can never see a row that is still pending work.
CREATE INDEX IF NOT EXISTS idx_outbox_published_at
    ON outbox (published_at)
    WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consumed_events_consumed_at
    ON consumed_events (consumed_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
    ON idempotency_keys (created_at);
