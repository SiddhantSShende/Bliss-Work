-- 0018_drop_forwarding.sql — remove message forwarding entirely.
--
-- Forwarding is gone in all three of its forms: the internal Bliss-Work relay
-- (0008), the outbound-to-external send through integrations-svc, and the wa.me
-- deep link (0014_forward_link). The API routes, the store layer, the
-- message.forwarded event and the whole client surface were removed alongside
-- this file; nothing reads what it drops.
--
-- THIS MIGRATION IS DESTRUCTIVE AND IRREVERSIBLE. It deletes recorded forward
-- provenance — who forwarded whose message, to whom, and when. There is no
-- backup step here and no way to reconstruct the edges from the remaining
-- tables: the clone rows survive, but what marked them as clones does not.
-- Take a dump first if that history has any value.
--
-- Idempotent, like every file here: DROP ... IF EXISTS throughout, so a re-run
-- (see Store.Migrate, which re-executes any file whose checksum changed) is a
-- no-op rather than an error.

-- ─────────────────────────────────────────────────────────────────────────────
-- message_forwards ─ the provenance edges themselves.
-- ─────────────────────────────────────────────────────────────────────────────
-- Its indexes and RLS policy go with the table. 0007_rls.sql still names
-- 'message_forwards' in org_tables[], which is deliberately left alone: that
-- loop skips a table that isn't present, so a fresh database (where 0007 runs
-- before 0008 creates it) and an existing one both stay correct without editing
-- a migration that has already been applied.
DROP TABLE IF EXISTS message_forwards;

-- ─────────────────────────────────────────────────────────────────────────────
-- messages ─ the back-pointers that marked a row as a forwarded clone.
-- ─────────────────────────────────────────────────────────────────────────────
-- Added by 0008. Dropped rather than left in place because appendMessage no
-- longer writes them, so every future row would carry a silent `false` that
-- reads as "this was not a forward" when the truth is "forwarding no longer
-- exists" — a column that answers a question nobody may ask again.
ALTER TABLE messages DROP COLUMN IF EXISTS is_forward;
ALTER TABLE messages DROP COLUMN IF EXISTS forwarded_from_message_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- The 'forward_external' system entries.
-- ─────────────────────────────────────────────────────────────────────────────
-- These are the server-authored pills ("Opened WhatsApp to forward this to Jane
-- Doe") that 0014 introduced, in both DMs and channels. They are deleted rather
-- than left behind, and the reason is not tidiness.
--
-- MessageKindWire parses an unrecognised kind as 'text' (a deliberate
-- wire-tolerance choice, so an old client never loses a whole conversation to
-- one unknown kind). With 'forward_external' removed from the enum, every
-- surviving pill would therefore render as an ORDINARY MESSAGE BUBBLE attributed
-- to its sender — turning "Opened WhatsApp to forward this to IT Support
-- (+1800…)" into something that looks exactly like the sender typed it. That is
-- precisely the impersonation the original code kept the kind out of
-- ValidMessageKind to prevent, so leaving the rows would resurrect the risk at
-- the moment the guard was removed.
DELETE FROM messages         WHERE kind = 'forward_external';
DELETE FROM channel_messages WHERE kind = 'forward_external';

-- NOT dropped, on purpose:
--
--   * channel_messages.kind — added by 0014 for the forward pill, but since read
--     by channels_read.go on every channel-message fetch. Dropping it breaks
--     channel reads outright.
--   * messages.kind — still carries 'call_missed'.
