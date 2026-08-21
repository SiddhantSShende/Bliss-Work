-- 0028_channel_read_receipts.sql — who in a channel has seen how far.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── Why a read cursor and not a row per (message, reader) ────────────────────
-- A DM has one peer, so `message_delivery` can afford a row per message: one
-- write per message, and the table grows with the conversation. A channel is
-- fan-out. The same shape there is a row per message PER MEMBER — a
-- five-hundred-member channel with ten thousand messages is five million rows
-- that say nothing the member's position in the channel does not already say,
-- and every channel-open would write one insert per message on screen.
--
-- So a channel member carries a cursor, exactly as `conversation_members` has
-- since 0001: reading is one UPDATE regardless of how far you scrolled, and
-- "who has seen message X" is "which members' cursors have reached X.seq".
-- Storage is one row per membership, which the table already had.
--
-- ── Why GREATEST, and never an assignment ───────────────────────────────────
-- The cursor only ever moves forward, which is what makes it safe to write from
-- whichever of somebody's tabs happens to scroll first. MarkChannelRead applies
-- GREATEST for that reason; the column's default of 0 is "has read nothing",
-- which is the honest state for every membership that predates this file.

ALTER TABLE channel_members
    ADD COLUMN IF NOT EXISTS last_read_seq bigint NOT NULL DEFAULT 0;

-- When the cursor last moved. The receipts view renders this as "Seen 14:32",
-- and it is per-member rather than per-message: it is the moment they caught
-- up, which is the closest honest answer a cursor can give to "when did they
-- see this one". NULL means a membership that has never read anything, which is
-- every row written before this migration.
ALTER TABLE channel_members
    ADD COLUMN IF NOT EXISTS last_read_at timestamptz;

-- The receipts read is "for this channel, which members are at or past seq N".
-- Leading with channel_id keeps that to one small slice per channel rather than
-- a scan of every membership in the org, and carrying last_read_seq in the
-- index lets the comparison be answered without touching the heap.
CREATE INDEX IF NOT EXISTS idx_channel_members_read_cursor
    ON channel_members (channel_id, last_read_seq);
