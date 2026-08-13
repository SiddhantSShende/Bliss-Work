-- 0014_message_features.sql — chat origin, reply, delete, reactions.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- Four unrelated-looking changes that are all the same shape: things the chat UI
-- has needed since it shipped and that the schema had no room for.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. threads.origin — WHICH SURFACE STARTED THIS THREAD
--
-- The Inbox is an email-style surface and Chats is instant messaging, but both
-- ran through the same appendMessage, which writes an inbox_items row for every
-- message either way. The Inbox FEED hid them by filtering to item_kind='TASK',
-- yet /inbox/peers still summed THREAD+TASK — so the rail's Inbox badge counted
-- chat traffic and the People sidebar listed peers whose feed then rendered
-- empty. That is what "chat notifications appear in the Inbox" actually was.
--
-- 'chat' is the DEFAULT, not 'mail': every existing thread was created by a send
-- that predates the distinction, and the overwhelming majority of them are chat.
-- Compose (the email-style dialog) is the only caller that asks for 'mail'.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE threads
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'chat';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'threads_origin_chk'
    ) THEN
        ALTER TABLE threads
            ADD CONSTRAINT threads_origin_chk CHECK (origin IN ('chat', 'mail'));
    END IF;
END $$;

-- Hide, do not delete, the THREAD rows written before the distinction existed.
--
-- Their origin cannot be reconstructed — nothing recorded which surface sent
-- them — so leaving them visible would keep the Inbox full of chat, and deleting
-- them would throw away rows that a future backfill might want. hidden_for_owner
-- is the existing, reversible "not in my inbox" flag, and flipping it back is a
-- one-line UPDATE if this turns out to be wrong.
--
-- Guarded so re-running the migration cannot re-hide a row the user has since
-- revived by replying to it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = 'inbox_items_thread_backfill_done'
    ) THEN
        UPDATE inbox_items SET hidden_for_owner = true WHERE item_kind = 'THREAD';
        -- A marker relation, so "has this one-shot backfill run?" is answerable
        -- without a schema_migrations-style bookkeeping table this service does
        -- not have.
        CREATE TABLE inbox_items_thread_backfill_done ();
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. messages.reply_to_id — INLINE REPLY
--
-- Deliberately NOT parent_message_id. That column means Gmail-style THREADING:
-- resolveThreadForReply reads it to decide which thread a message joins, and
-- overloading it for "this bubble quotes that bubble" would reshape the Inbox
-- thread tree every time someone replied to a chat message.
--
-- No FK: messages is large and self-referential FKs cost an index maintenance
-- per insert on the hot send path. A dangling id renders as "Original message",
-- which is the same fallback a reply to an out-of-page message already needs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS reply_to_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Deletion — TWO DIFFERENT ACTS
--
-- "Delete for everyone" is a fact about the MESSAGE: one timestamp, everyone
-- sees the tombstone. "Delete for me" is a fact about one READER: a row per
-- (message, user).
--
-- Both are soft. The row has to survive because `seq` is the conversation's
-- ordering key and message_delivery/message_forwards reference the id; deleting
-- it would punch a hole in the sequence and orphan the receipts. Keeping it also
-- means the recipient sees "this message was deleted" where the message was,
-- rather than a silent gap they never learn about.
--
-- deleted_for_all_at is separate from sender_dismissed_at, which is the older
-- SENDER-ONLY hide used by the Inbox and stays exactly as it was.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS deleted_for_all_at timestamptz;
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS deleted_by uuid;

CREATE TABLE IF NOT EXISTS message_hides (
    message_id uuid        NOT NULL,
    user_id    uuid        NOT NULL,
    org_id     uuid        NOT NULL,
    hidden_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

-- Every message read filters against this for the CALLER, so the lookup is by
-- user first — one small, hot slice per reader rather than a scan per message.
CREATE INDEX IF NOT EXISTS idx_message_hides_user
    ON message_hides (user_id, message_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. message_reactions — ONE ROW PER (message, user, emoji)
--
-- The PK is the uniqueness rule: a person may react with several DIFFERENT
-- emoji to the same message, but reacting twice with the same one is the same
-- reaction. That makes "toggle" an INSERT … ON CONFLICT DO NOTHING and a DELETE,
-- with no read-modify-write and therefore no lost-update race between devices.
--
-- `emoji` is stored as text rather than a numeric id: an emoji is already a
-- Unicode string, a lookup table would need migrating every time the palette
-- grows, and the API layer bounds the length so the column cannot become a
-- free-text field.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id uuid        NOT NULL,
    user_id    uuid        NOT NULL,
    org_id     uuid        NOT NULL,
    emoji      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Reading a page of messages needs every reaction on those message ids at once.
CREATE INDEX IF NOT EXISTS idx_message_reactions_message
    ON message_reactions (message_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the two new tables.
--
-- Inline, NOT in 0007_rls.sql: that migration enumerates a fixed table list and
-- has already run in production, so it will never cover a table added later.
-- Every new org-bearing table has to bring its own policy — same rule
-- 0013_channel_blocks.sql follows.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['message_hides', 'message_reactions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE policyname = 'org_isolation' AND tablename = t
        ) THEN
            EXECUTE format($pol$
                CREATE POLICY org_isolation ON %I
                    USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                                OR current_setting('app.bypass_rls', true) = 'on')
                    WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                                OR current_setting('app.bypass_rls', true) = 'on')
            $pol$, t);
        END IF;
    END LOOP;
END $$;
