-- 0017_outbox_dead_letter.sql — stop one bad row from stopping every event.
--
-- ── The failure this removes ─────────────────────────────────────────────────
-- The poller claimed `ORDER BY created_at LIMIT n` and published the batch in
-- one call. Any publish failure marked nothing, so the next tick re-claimed the
-- same rows — the same head of the queue, the same failure, every 500 ms,
-- forever. There was no attempt counter, no quarantine and no alert.
--
-- That is fine for a TRANSIENT failure, which is what the design assumed: a
-- broker blip clears and the batch drains. It is fatal for a PERMANENT one. A
-- row larger than the broker's message limit can never be published, so it sat
-- at the head of the queue and every event behind it — every message, every
-- notification, every task and integration event, for every organisation —
-- stopped with it. Recovery meant a human finding and deleting the row.
--
-- ── What these columns do ────────────────────────────────────────────────────
-- `publish_attempts` counts failed drains so a row that cannot be sent is
-- eventually recognised rather than retried indefinitely. `dead_lettered_at`
-- takes it out of the queue, and `publish_error` records why so the row can be
-- diagnosed and, once the cause is fixed, replayed by clearing the column.
--
-- Rows are quarantined, never deleted. An event that failed to publish is
-- evidence; deleting it would destroy the only copy of something a consumer was
-- supposed to see.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_attempts  integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dead_lettered_at  timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS publish_error     text;

-- The claim index has to carry the quarantine predicate or the poller keeps
-- reading dead rows and skipping them in Go — which is the same head-of-line
-- stall wearing a different hat once enough of them accumulate.
--
-- Replaces idx_outbox_unpublished from 0001. Created BEFORE the old one is
-- dropped so the claim query is never without an index.
CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON outbox (created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

DROP INDEX IF EXISTS idx_outbox_unpublished;

-- Answers "is anything stuck right now" in one index-only scan, for the
-- Prometheus exporter and for a human at 3am.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
    ON outbox (dead_lettered_at DESC)
    WHERE dead_lettered_at IS NOT NULL;

-- ── Retention support ────────────────────────────────────────────────────────
--
-- Nothing ever deleted from these tables — `DELETE FROM outbox` appears nowhere
-- in the repository, in any of the seven services that have one — so they hold
-- one row per event ever produced or consumed, with the full JSON payload, for
-- the life of the deployment. cmd/prune-event-tables now applies retention;
-- these are the indexes its predicates need.
--
-- Without them the prune is a sequential scan over the very table whose size is
-- the problem, which is how a retention job becomes the incident it was added
-- to prevent.
--
-- Partial on `published_at IS NOT NULL`, which is the complement of the claim
-- index above: the two together cover the table with no overlap, and the prune
-- can never see a row that is still pending work.
CREATE INDEX IF NOT EXISTS idx_outbox_published_at
    ON outbox (published_at)
    WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consumed_events_consumed_at
    ON consumed_events (consumed_at);

CREATE INDEX IF NOT EXISTS idx_consumed_events_inbox_tasks_consumed_at
    ON consumed_events_inbox_tasks (consumed_at);

-- idempotency_keys already has idx_idempotency_keys_created from
-- 0003_threads_inbox.sql — an index on created_at whose only conceivable use is
-- a sweeper by age, created for a sweeper that was never written. It is finally
-- the index it was always meant to be.
