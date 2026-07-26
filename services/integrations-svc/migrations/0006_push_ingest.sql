-- 0006_push_ingest.sql — push subscriptions + ingest cursors for Gmail/Graph.
-- Idempotent; replayed on every boot by db.py::run_migrations, like every file here.
--
-- Gmail and Microsoft deliver new mail/chat by PUSHING to us (Pub/Sub watch,
-- Graph change notifications) rather than by us polling. Both vendors:
--   * expire the subscription — Gmail watch after 7 days, Graph mail after
--     ~3 days and Graph CHAT after ~60 minutes, and
--   * drop notifications occasionally, with no error and no retry.
-- So a renewal worker is mandatory, and a low-frequency reconciliation sweep is
-- the only thing standing between a dropped notification and a permanently
-- missed mention.

ALTER TABLE integration_connections
    -- Where ingest resumes: a Gmail historyId, or a Graph @odata.deltaLink.
    --
    -- Its OWN column, deliberately NOT inside metadata_enc: that blob holds the
    -- connect credentials and is set to NULL on disconnect, which would race a
    -- worker mid-sweep and lose the cursor. Encrypted because a deltaLink
    -- embeds a mailbox-scoped token.
    ADD COLUMN IF NOT EXISTS ingest_cursor_enc     bytea,

    -- The provider-side subscription we must renew: Gmail's watch expiration,
    -- or the Graph subscription id + clientState. Encrypted — clientState is
    -- the only thing authenticating an inbound Graph notification.
    ADD COLUMN IF NOT EXISTS push_subscription_enc bytea,
    ADD COLUMN IF NOT EXISTS push_expires_at       timestamptz,

    -- Graph's subscription id, in PLAINTEXT and indexed.
    --
    -- Same reasoning as webhook_token in 0005: an inbound notification is
    -- resolved on a public path with no org context, so there is no key to
    -- decrypt under yet. It is an opaque identifier that authenticates nothing
    -- — the encrypted clientState alongside it does that — it only answers
    -- "which connection is this notification for?".
    ADD COLUMN IF NOT EXISTS push_subscription_id  text,

    -- Consecutive failures, for capped exponential backoff. Reset to 0 on any
    -- success so a connection that recovers returns to the normal cadence
    -- immediately rather than serving out its penalty.
    ADD COLUMN IF NOT EXISTS ingest_failures       int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingest_error          text,

    -- Lease/visibility timestamp. The worker claims rows with
    -- `next_ingest_at <= now()` under FOR UPDATE SKIP LOCKED and pushes this
    -- forward before releasing, so a second replica — or a restart mid-sweep —
    -- cannot double-process a connection.
    ADD COLUMN IF NOT EXISTS next_ingest_at        timestamptz NOT NULL DEFAULT now();

-- The worker's claim query: "connections due for a sweep, oldest first".
-- Partial on status so revoked/errored rows never enter the index — those are
-- the majority once an org churns through connections.
CREATE INDEX IF NOT EXISTS idx_integration_conn_next_ingest
    ON integration_connections (next_ingest_at)
    WHERE status = 'connected';

-- The renewal query: "subscriptions expiring soon". Separate from the sweep
-- index because renewal is time-driven by the PROVIDER's expiry, not by our own
-- cadence — a chat subscription expiring in 60 minutes needs renewing long
-- before its next reconciliation sweep would come due.
CREATE INDEX IF NOT EXISTS idx_integration_conn_push_expiry
    ON integration_connections (push_expires_at)
    WHERE status = 'connected' AND push_expires_at IS NOT NULL;

-- Notification lookup. Globally unique because the resolve happens with no org
-- context, so the id alone has to identify exactly one row — and because Graph
-- issues these ids, two connections cannot legitimately share one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_conn_push_sub
    ON integration_connections (push_subscription_id)
    WHERE push_subscription_id IS NOT NULL;
