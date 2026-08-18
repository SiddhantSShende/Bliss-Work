-- 0022_channel_message_actions.sql — delete, pin and react on CHANNEL messages.
--
-- The per-bubble "..." menu has existed in chat since 0014, but everything
-- behind it (hide, delete-for-everyone, reactions) was written against the DM
-- `messages` table. Channel messages live in `channel_messages`, a separate
-- table, so in a channel the menu rendered with only its two forward entries
-- and nothing else — the actions were not broken so much as never wired.
--
-- IDEMPOTENT: every statement guards re-execution.
--
-- ── What is NOT here, and why ────────────────────────────────────────────────
-- `message_hides` and `message_reactions` (both 0014) are reused as-is. Neither
-- carries a foreign key to `messages` — 0014 dropped the FK on the reaction
-- table for insert cost and the hide table never had one — and both are keyed on
-- a bare `message_id uuid`. A channel message id is a uuid from the same v7
-- space, so the existing rows, indexes and RLS policies cover channel messages
-- without a second pair of tables to keep in sync. The one thing that buys us is
-- that `reactionsFor` works unchanged for both kinds of message.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Deletion — the same two acts the DM table already models.
--
-- "Delete for me" needs no column: it is a `message_hides` row.
-- "Delete for everyone" is a fact about the message, so it is a timestamp here.
--
-- SOFT, exactly as in 0014: `seq` is the channel's ordering key and a hard
-- delete would punch a hole in it. The reader sees a tombstone where the
-- message was rather than a silent gap that rewrites what they remember.
--
-- `deleted_by` is recorded separately from the sender because in a channel the
-- deleter is frequently NOT the author — an owner or admin moderating someone
-- else's message is the main reason this exists.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS deleted_for_all_at timestamptz;
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS deleted_by         uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Pinning — "pin for everyone", so a channel can keep the message that
--    matters at hand.
--
-- Columns on the message rather than a `channel_pins` join table: a pin is a
-- property of the message (at most one per message, no payload of its own), and
-- the read it has to serve is "which messages in THIS channel are pinned",
-- which the partial index below answers directly. A join table would add a row
-- lifecycle and a second delete path for no capability.
--
-- `pinned_by` is kept after unpinning is not a concern — unpin nulls both, so
-- the pair is always consistent.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS pinned_by uuid;

-- PARTIAL, and that is the point: pins are a handful of rows in a table that
-- grows without bound, so indexing only the pinned ones keeps this a few pages
-- rather than a shadow of the whole table. Ordered newest-first, which is how
-- the channel header lists them.
CREATE INDEX IF NOT EXISTS idx_channel_messages_pinned
    ON channel_messages (channel_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Reading a page of channel messages now filters `message_hides` for the
--    CALLER, which is a lookup by (user_id, message_id).
--
-- 0014 already created idx_message_hides_user in exactly that column order for
-- the DM read path, and it serves this one unchanged. Named here so the next
-- person does not add a duplicate.
-- ─────────────────────────────────────────────────────────────────────────────

-- No RLS work: `channel_messages` has been policied since 0007 and a policy
-- covers the row, not the column. `message_hides` and `message_reactions` got
-- theirs inline in 0014.
