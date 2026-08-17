-- 002_outbox_dead_letter.sql — stop one bad row from stopping every event.
--
-- Same defect, same fix, same reasoning as messaging-svc/0017: the publisher
-- claimed `ORDER BY created_at LIMIT 100` and re-claimed the identical rows on
-- every 500 ms tick whenever the produce failed. Correct for a broker blip;
-- fatal for a row the broker will never accept, because that row sits at the
-- head of the queue forever and every notification behind it stops with it.
--
-- It matters more here than anywhere else in the platform: this is the
-- highest-fan-out topic in the product, so a stall is not one feature failing,
-- it is every notification for every organisation.
--
-- Rows are quarantined, never deleted. An event that failed to publish is the
-- only remaining copy of something a consumer was supposed to receive.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_attempts  integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dead_lettered_at  timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_error     text;

-- The claim index carries the quarantine predicate, or the publisher keeps
-- reading dead rows and skipping them in Go — the same head-of-line stall
-- wearing a different hat once enough accumulate.
CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON outbox (created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

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
