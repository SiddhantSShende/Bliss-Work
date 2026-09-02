-- 0031_channel_message_reply.sql — channel_messages.reply_to_id, the channel
-- twin of messages.reply_to_id (0014_message_features.sql).
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- Same rationale as the DM column: NOT parent_message_id (that would be
-- Gmail-style threading, which channels do not have at all), and no FK —
-- channel_messages is on the hot send path and a self-referential FK costs an
-- index maintenance per insert. A dangling id renders as "Original message" on
-- the client, the same fallback a reply to an out-of-page message already needs.
ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS reply_to_id uuid;
