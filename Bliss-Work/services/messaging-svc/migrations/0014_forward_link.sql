-- Deep-link forwarding to WhatsApp ("forward via wa.me").
--
-- The pre-existing outbound-to-external forward (0008 + forward_external.go) goes
-- through integrations-svc and the Meta Graph API, so it only works for an org
-- that has connected a WhatsApp BUSINESS account. A wa.me deep link needs none of
-- that: it hands the message to whatever WhatsApp the user already has.
--
-- The price is that a deep link is UNVERIFIABLE. It opens WhatsApp with the text
-- prefilled; the user may never press send, may switch contacts inside WhatsApp,
-- or may cancel. WhatsApp never calls back to say which. ForwardExternalRecord is
-- deliberately called only AFTER the provider accepted, "so the author only sees
-- forwards that actually left" — a deep link can never offer that, so rather than
-- quietly weakening the guarantee we make it a column and say so in the UI.
--
-- Additive, nullable/defaulted, idempotent — the same contract as 0008/0009.
-- (Reminder: there is no schema_migrations table. Store.Migrate re-executes every
-- file in this directory on every boot, so every statement here must be a no-op
-- the second time it runs.)

-- ─────────────────────────────────────────────────────────────────────────────
-- message_forwards ─ how much we actually know about this hop.
-- ─────────────────────────────────────────────────────────────────────────────

-- 'confirmed'   — a provider acknowledged the send (every pre-existing row, hence
--                 the DEFAULT: no backfill, and no existing row is made to lie).
-- 'unconfirmed' — we handed the message to the OS and stopped being able to see.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'confirmed';

-- The captured contact's display name, ENCRYPTED. It is a third party's personal
-- data (SECURITY.md §2 puts names in the PII tier: AES-256-GCM under the per-org
-- DEK, so an org erasure crypto-shreds it along with everything else). Nullable —
-- the picker may return a number with no name, and the manual form makes it
-- optional.
--
-- Note the inconsistency this leaves behind: forwarded_to_external (the phone
-- number itself) has been plaintext since 0008. Bringing it under the DEK is a
-- separate migration with a backfill, deliberately not folded in here.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS forwarded_to_name_enc bytea;

-- Set when the forwarded message lives in channel_messages rather than messages.
-- Two reasons it has to be stored rather than derived: the root-message lookups
-- (ListForwards, ListMyForwardActivity) LEFT JOIN `messages` and would render a
-- blank preview for a channel root, and message_forwards has no FK on
-- root_message_id (see 0008) precisely so ids from either table can live here.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS channel_id uuid;

-- The CHECK is added separately and guarded: ADD COLUMN IF NOT EXISTS skips the
-- whole statement on a re-run, but ADD CONSTRAINT has no IF NOT EXISTS and would
-- abort the migration the second time round.
DO $mfd$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'message_forwards_delivery_check'
          AND conrelid = 'message_forwards'::regclass
    ) THEN
        ALTER TABLE message_forwards
            ADD CONSTRAINT message_forwards_delivery_check
            CHECK (delivery IN ('confirmed','unconfirmed'));
    END IF;
END
$mfd$;

-- ─────────────────────────────────────────────────────────────────────────────
-- channel_messages ─ the system-entry mechanism DMs got in 0009.
-- ─────────────────────────────────────────────────────────────────────────────
-- Same rationale as 0009, now that a forward pill has to render in a channel too:
-- "Opened WhatsApp to forward this to Jane Doe" must be distinguishable from a
-- member literally typing that sentence, and a client must not be able to fake
-- one by choosing the right words. Whitelisted server-side; never taken from raw
-- client input.
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';

-- No RLS work: both tables are already policied (0007 for channel_messages, 0008
-- inline for message_forwards) and a policy covers the row, not the column.
