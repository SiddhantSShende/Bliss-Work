-- 005_outbox — transactional outbox for sticky.pin.changed.
--
-- Until now this service only CONSUMED events. A user's pin/unpin is a state
-- change that every other device of theirs must hear about, so it now produces
-- one — and, like every other producer in this repo, writes it to an outbox in
-- the SAME transaction as the state change, so a pin that committed can never
-- lose its event and an event can never describe a pin that rolled back.
--
-- Same shape as task-svc's outbox (001_init + 008_outbox_dead_letter), which is
-- what services/shared/outbox_dlq operates on. No org_id and no RLS: it holds
-- opaque payloads drained by a cross-org poller running under set_bypass_rls,
-- exactly like task-svc's.
CREATE TABLE IF NOT EXISTS outbox (
    id               uuid        PRIMARY KEY,
    topic            text        NOT NULL,
    kafka_key        text        NOT NULL,
    payload          jsonb       NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    published_at     timestamptz,
    publish_attempts integer     NOT NULL DEFAULT 0,
    dead_lettered_at timestamptz,
    publish_error    text
);

-- The poller's claim: unpublished and not quarantined.
CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON outbox (created_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- "Is anything stuck right now" in one index-only scan.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
    ON outbox (dead_lettered_at DESC)
    WHERE dead_lettered_at IS NOT NULL;

-- Retention: the exact complement of the claim index (published rows only).
CREATE INDEX IF NOT EXISTS idx_outbox_published_at
    ON outbox (published_at)
    WHERE published_at IS NOT NULL;
