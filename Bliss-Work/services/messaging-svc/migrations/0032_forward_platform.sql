-- 0032_forward_platform.sql — a trusted, machine-readable destination on an
-- EXTERNAL forward pill, so the client can render the destination's name
-- instead of it being baked into the pill's own text.
--
-- message_forwards.platform (0021/0019) already records the normalized
-- destination for provenance/audit purposes, but nothing links a `platform`
-- value back to the SYSTEM MESSAGE (in `messages` or `channel_messages`) that
-- the reader actually sees — ForwardLinkRecord writes message_forwards and the
-- pill in the same transaction, but as two independent rows with no shared key
-- (message_forwards carries no client_msg_id, and the pill carries no
-- message_forwards id). Today the pill's body text is composed server-side
-- with the destination's display name spelled out in prose ("Opened WhatsApp
-- to forward..."), which is the ONLY way the reader learns which app it went
-- to. That stops the UI from being a generic, provider-driven renderer: adding
-- a second destination would mean teaching store/forward_link.go a new prose
-- string rather than the client just reading which provider this pill is for.
--
-- forward_platform is that missing link, set once at pill-creation time from
-- the SAME literal the message_forwards row for this forward was given
-- (internal/store/external_platform.go's PlatformWhatsApp), so the two can
-- never drift for a single forward action. NULL for every ordinary message and
-- for an INTERNAL forward's clone (is_forward from 0021 already covers that
-- case) — this column exists only for kind = 'forward_external'.
--
-- Idempotent, like every file here: guarded throughout, so a re-run is a no-op.

ALTER TABLE messages         ADD COLUMN IF NOT EXISTS forward_platform text;
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS forward_platform text;

-- Same allowed set as message_forwards_delivery_check's sibling, the implicit
-- CHECK 0008 put on message_forwards.platform — kept in sync by hand since
-- Postgres has no way to share one CHECK across two tables. 'blisswork' is
-- deliberately excluded: an internal forward's clone is already marked by
-- is_forward and never sets this column, so a value here always means
-- "this pill is about a forward that left the workspace."
--
-- ADD CONSTRAINT has no IF NOT EXISTS and would abort on a re-run, so both are
-- guarded rather than repeated.
DO $mfp1$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_forward_platform_check'
          AND conrelid = 'messages'::regclass
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT messages_forward_platform_check
            CHECK (forward_platform IS NULL OR forward_platform IN
                   ('whatsapp', 'slack', 'teams', 'gmail', 'outlook'));
    END IF;
END
$mfp1$;

DO $mfp2$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'channel_messages_forward_platform_check'
          AND conrelid = 'channel_messages'::regclass
    ) THEN
        ALTER TABLE channel_messages
            ADD CONSTRAINT channel_messages_forward_platform_check
            CHECK (forward_platform IS NULL OR forward_platform IN
                   ('whatsapp', 'slack', 'teams', 'gmail', 'outlook'));
    END IF;
END
$mfp2$;

-- Rows written before this migration keep forward_platform NULL — there is no
-- other platform they could have been, but backfilling them would also require
-- rewriting their body text (still the pre-existing full "Opened WhatsApp to
-- forward..." prose) to strip the now-redundant destination name, which is a
-- content rewrite this migration does not take on. The client's renderer
-- (ForwardBadge) falls back to that legacy body verbatim when forward_platform
-- is NULL, so old pills keep reading exactly as they always have.
