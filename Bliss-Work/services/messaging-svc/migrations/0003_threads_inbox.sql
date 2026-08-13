-- 0003_threads_inbox.sql — Gmail-style Inbox + email-style threading (additive).
--
-- This migration is IDEMPOTENT. Every statement guards re-execution.
--
-- Conventions:
--  * Every uuid PK on a new table is uuidv7 generated APP-SIDE — pin this so
--    the (last_event_at, ref_id) inbox cursor breaks ties deterministically
--    in time order (uuidv4 ordering is undefined; uuidv7 is monotonic).
--  * No NOT NULL constraint added on legacy columns until the backfill (Phase 2)
--    has populated every row. ALL Phase 1 additions are NULLABLE.
--  * inbox_items is HASH-partitioned by owner_user_id (N=64) to keep the
--    primary read-side query (one keyset paginated SELECT per inbox open)
--    on a hot partition that fits comfortably in shared_buffers even at 1B DAU.

-- ─────────────────────────────────────────────────────────────────────────────
-- threads ─ one row per Gmail-style "conversation root" inside a 1:1 conv.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS threads (
    id               uuid PRIMARY KEY,            -- uuidv7
    org_id           uuid NOT NULL,
    conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    root_message_id  uuid NOT NULL,               -- messages(id) — no FK; circular dep at insert
    sender_id        uuid NOT NULL,               -- whoever wrote the root
    recipient_id     uuid NOT NULL,
    subject_preview  text NOT NULL DEFAULT '',    -- first ~80 chars for the list pane
    last_event_at    timestamptz NOT NULL DEFAULT now(),
    last_message_seq bigint NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, root_message_id)
);

CREATE INDEX IF NOT EXISTS idx_threads_conv_last_event
    ON threads (conversation_id, last_event_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- thread_members ─ per-(user, thread) state. Two rows per 1:1 thread.
-- Replaces "ignore the whole conversation" semantics with per-thread ignore.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS thread_members (
    thread_id          uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_id            uuid NOT NULL,
    org_id             uuid NOT NULL,
    last_read_seq      bigint NOT NULL DEFAULT 0,
    hidden_for_owner   bool NOT NULL DEFAULT false,    -- "Ignore" — revives on reply
    deleted_for_owner  bool NOT NULL DEFAULT false,    -- reserved; not used in Phase 3
    hidden_at          timestamptz,
    PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_members_user_visible
    ON thread_members (user_id) WHERE NOT hidden_for_owner AND NOT deleted_for_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- inbox_items ─ unified feed projection (messages + tasks).
--
-- HASH-partitioned by owner_user_id (N=64). A user's whole inbox lives on one
-- partition, so the (owner_user_id, last_event_at DESC, ref_id DESC) keyset
-- pagination index is local to that partition — fast even at 1B DAU because
-- no user ever pays the cost of any other user's writes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbox_items (
    org_id            uuid NOT NULL,
    owner_user_id     uuid NOT NULL,
    item_kind         text NOT NULL CHECK (item_kind IN ('THREAD', 'TASK')),
    ref_id            uuid NOT NULL,                          -- uuidv7
    peer_user_id      uuid,                                   -- counterparty
    preview           text NOT NULL DEFAULT '',
    last_event_at     timestamptz NOT NULL DEFAULT now(),
    unread_count      int NOT NULL DEFAULT 0,
    status_badge      text,                                   -- 'SENT','DELIVERED','SEEN','ACKNOWLEDGED','COMPLETED','IGNORED','LEFT'
    hidden_for_owner  bool NOT NULL DEFAULT false,
    deleted_for_owner bool NOT NULL DEFAULT false,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_user_id, item_kind, ref_id)
) PARTITION BY HASH (owner_user_id);

-- Create the 64 hash partitions exactly once (CREATE TABLE … PARTITION OF is
-- itself idempotent via IF NOT EXISTS).
DO $do$
BEGIN
    FOR i IN 0..63 LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS inbox_items_p%s PARTITION OF inbox_items FOR VALUES WITH (modulus 64, remainder %s)',
            lpad(i::text, 2, '0'), i
        );
    END LOOP;
END
$do$;

-- Visible-only keyset index — declared on the parent so each partition inherits.
CREATE INDEX IF NOT EXISTS idx_inbox_items_owner_recency
    ON inbox_items (owner_user_id, last_event_at DESC, ref_id DESC)
    WHERE NOT hidden_for_owner AND NOT deleted_for_owner;

-- Secondary index for the per-(peer) lookup used by the task projector on
-- TaskIgnored to find/update the right inbox row.
CREATE INDEX IF NOT EXISTS idx_inbox_items_owner_kind_ref
    ON inbox_items (owner_user_id, item_kind, ref_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- message_delivery ─ per-(message, recipient) delivery + read receipts.
-- Powers the per-message Delivered/Seen badge for the sender.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_delivery (
    message_id    uuid NOT NULL,
    recipient_id  uuid NOT NULL,
    delivered_at  timestamptz,
    read_at       timestamptz,
    PRIMARY KEY (message_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_message_delivery_recipient
    ON message_delivery (recipient_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- consumed_events_inbox_tasks ─ dedup table for Phase 2's task projector.
-- Lives separately from the existing consumed_events so two consumer groups in
-- the same service don't fight over the same event_id key.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumed_events_inbox_tasks (
    event_id    uuid PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- messages ─ additive columns + widened UNIQUE for per-thread idempotency.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id          uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_message_id  uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_thread_root     bool NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS server_acked_at    timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_dismissed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_messages_thread_seq
    ON messages (thread_id, seq) WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_parent
    ON messages (parent_message_id) WHERE parent_message_id IS NOT NULL;

-- Index for the sender-view query that excludes their own dismissals.
CREATE INDEX IF NOT EXISTS idx_messages_sender_dismissed
    ON messages (sender_id, conversation_id) WHERE sender_dismissed_at IS NULL;

-- Widen the per-(conversation, sender, client_msg_id) uniqueness to include
-- thread_id so two replies in different threads of the same conversation that
-- happen to share a clientMsgId (e.g. send-from-sticky races) don't collide.
DO $do$
BEGIN
    -- Drop the old constraint exactly once (name from the auto-generator).
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_conversation_id_sender_id_client_msg_id_key'
    ) THEN
        ALTER TABLE messages DROP CONSTRAINT messages_conversation_id_sender_id_client_msg_id_key;
    END IF;

    -- Add the new wider constraint exactly once.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_conv_sender_clientmsg_thread_key'
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT messages_conv_sender_clientmsg_thread_key
            UNIQUE (conversation_id, sender_id, client_msg_id, thread_id);
    END IF;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_projection ─ denormalize email at write time. The Phase 6 SMTP relay
-- looks recipients up here instead of calling auth-svc per event (no new
-- internal endpoint, no new auth scope).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_projection ADD COLUMN IF NOT EXISTS email text;

CREATE INDEX IF NOT EXISTS idx_user_projection_email
    ON user_projection (email) WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- idempotency_keys ─ Phase 3 idempotency middleware support. Endpoints with no
-- natural client_msg_id (dismiss, ignore, read) read the Idempotency-Key
-- header and claim it here; replays return 204/200 without re-running the side
-- effect. 14-day TTL via a periodic cleanup is acceptable; replays past that
-- window are rare and at worst do the safe (idempotent) op a second time.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id    uuid NOT NULL,
    key        text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
    ON idempotency_keys (created_at);
