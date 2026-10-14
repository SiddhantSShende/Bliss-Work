-- 0019_mail_sync_links.sql — per-mailbox Graph message id <-> messaging-svc mail.
--
-- internetMessageId (already used by messaging-svc's mail_messages dedup index)
-- is the SAME string in every mailbox that holds a copy of one message. Graph's
-- own `id` is NOT — it is scoped to one mailbox. Write-back (mail_sync_worker
-- marking a message read, or moving it to Deleted Items on the connected user's
-- behalf) has to call Graph with THAT mailbox's id, so it needs its own mapping
-- rather than reusing the cross-mailbox dedup key.
--
-- One row per (connection, graph message). mail_id is messaging-svc's
-- mail_messages.id — no FK, since that table lives in a different database.

CREATE TABLE IF NOT EXISTS mail_sync_links (
    id                 uuid PRIMARY KEY,
    connection_id      uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    org_id             uuid NOT NULL,
    mail_id            uuid NOT NULL,
    graph_message_id   text NOT NULL,
    folder             text NOT NULL CHECK (folder IN ('inbox', 'sentitems')),
    -- The isRead we last observed OR last wrote ourselves, kept in step so a
    -- later delta walk reporting the state we just wrote back isn't mistaken
    -- for a fresh change made directly in Outlook. Not required for
    -- correctness (both directions are idempotent and converge regardless) —
    -- only avoids a redundant round trip.
    last_known_is_read boolean,
    last_synced_at     timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- One graph message maps to at most one local mail, per connection.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_sync_links_conn_graph
    ON mail_sync_links (connection_id, graph_message_id);

-- Write-back lookup: "does THIS connection have a Graph message for this
-- local mail?" — scoped to connection_id so one recipient's read/delete action
-- can never resolve to a DIFFERENT recipient's mailbox.
CREATE INDEX IF NOT EXISTS idx_mail_sync_links_conn_mail
    ON mail_sync_links (connection_id, mail_id);

-- "Last sync time" surfaced in the Settings UI (routes/integrations.py).
CREATE INDEX IF NOT EXISTS idx_mail_sync_links_conn_synced
    ON mail_sync_links (connection_id, last_synced_at DESC);

-- 0012_org_isolation.sql's shared helper — see its own docstring for why this
-- is a function call rather than an inlined ENABLE/FORCE/CREATE POLICY block.
SELECT apply_org_isolation('mail_sync_links');
