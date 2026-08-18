-- 0021_forward_internal.sql — forwarding a message to another chat or channel
-- INSIDE the workspace.
--
-- 0019 restored the wa.me deep link, which hands a message to the operating
-- system and ends our visibility. This adds the other half back: a forward that
-- never leaves BlissWork, where the message really is delivered and we can say
-- so. Both paths write to message_forwards; they are told apart by `platform`
-- ('blisswork' here, 'whatsapp' there) and by whether forwarded_message_id is
-- set, since only this one creates a clone.
--
-- The reason it is worth restoring rather than leaving people to re-upload a
-- file by hand: an attachment is authorized by (scope, scope_id), so its ids
-- mean nothing outside the conversation it was uploaded to. Forwarding a photo
-- therefore has to RE-SCOPE it — a new attachments row for the destination,
-- pointing at the same content-addressed blob — which is something only the
-- server can do. See store/forward_attachments.go.
--
-- Idempotent, like every file here: guarded throughout, so a re-run is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- messages / channel_messages ─ the marker on a forwarded CLONE.
-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 put these on `messages` and 0018 dropped them again. They come back on
-- BOTH tables this time, because a channel is now a forward destination too.
--
-- Nullable / DEFAULTed, never NOT NULL on an existing table. `is_forward` is
-- what makes the receiving client render "Forwarded" above the bubble: a
-- forwarded photo that looked authored by the forwarder would misattribute
-- someone else's content to them, which is exactly the confusion the label
-- exists to prevent.
--
-- forwarded_from_message_id carries no FK for the same reason message_forwards
-- carries none: the source may live in `messages` OR `channel_messages`, and no
-- single table can be referenced.
ALTER TABLE messages         ADD COLUMN IF NOT EXISTS is_forward bool NOT NULL DEFAULT false;
ALTER TABLE messages         ADD COLUMN IF NOT EXISTS forwarded_from_message_id uuid;
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS is_forward bool NOT NULL DEFAULT false;
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- message_forwards ─ where an INTERNAL forward landed.
-- ─────────────────────────────────────────────────────────────────────────────
-- `forwarded_to` (a user id) has been there since 0008 and covers a DM target.
-- A channel target has no single user to name, so it gets its own column rather
-- than being squeezed into that one — a channel id sitting in a column every
-- other query reads as "the Bliss-Work user who received this" would silently
-- corrupt the author's "who forwarded my message where" view.
--
-- Distinct from the existing `channel_id`, which says where the message that was
-- forwarded LIVES. Source and destination are different questions and a forward
-- from one channel to another sets both.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS forwarded_to_channel_id uuid;

-- Provenance lookup when forwarding an already-forwarded message: the next hop
-- reads the chain by the clone's id. 0019 created this index partial on
-- forwarded_message_id IS NOT NULL and noted it indexed nothing while only the
-- deep-link path existed. This is the path that fills it.
CREATE INDEX IF NOT EXISTS idx_forwards_fwd_msg
    ON message_forwards (forwarded_message_id) WHERE forwarded_message_id IS NOT NULL;
