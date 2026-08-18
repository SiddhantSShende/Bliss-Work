-- 0019_restore_forward_link.sql — bring back message_forwards for deep-link
-- forwarding, after 0018_drop_forwarding removed forwarding in all three forms.
--
-- Only ONE of those three is being restored: the wa.me deep link (originally
-- 0014_forward_link). The internal Bliss-Work relay (0008) and the outbound send
-- through a connected WhatsApp Business account stay deleted, and their store
-- and API layers are not coming back. This file therefore recreates the table
-- 0008 defined plus the columns 0014 added, because the deep-link write path
-- uses both sets — not because the relay is returning.
--
-- 0018 is deliberately left untouched. Store.Migrate keeps a schema_migrations
-- ledger keyed by filename with a checksum, so an already-applied 0018 does not
-- re-run and will not drop what this file creates. Editing 0018 instead would
-- change its checksum and re-execute it on the next boot, dropping the table
-- again on every deploy.
--
-- WHAT IS NOT RESTORED: the forward provenance 0018 deleted. That DROP TABLE was
-- irreversible and this file cannot reconstruct it — the table comes back empty.
--
-- Idempotent, like every file here: guarded throughout, so a re-run is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- message_forwards ─ one row per forward hop.
-- ─────────────────────────────────────────────────────────────────────────────
-- Columns carry 0008's shape so the chain model still works: a hop points at the
-- ROOT message, and parent_message_id + depth + path reconstruct the chain and
-- give cycle detection. root_author_id is denormalized so the ws-gateway routes
-- message.forwarded to the original author with no DB lookup.
--
-- forwarded_message_id and forwarded_to are always NULL on the deep-link path
-- (there is no clone, and the target is not a Bliss-Work user). They are kept
-- rather than dropped because live SQL still references them: ForwardLinkRecord
-- inserts them explicitly and resolveLinkProvenance looks a chain up by
-- forwarded_message_id. With no relay writing clones that lookup now always
-- misses, which is correct — without clones there are no chains, so every
-- forward is depth 1 off its own root.
--
-- No FK on root_message_id / parent_message_id, exactly as in 0008: a forwarded
-- message may live in `messages` OR `channel_messages`, so no single table can
-- be referenced.
CREATE TABLE IF NOT EXISTS message_forwards (
    id                    uuid PRIMARY KEY,              -- uuidv7, app-side
    org_id                uuid NOT NULL,
    root_message_id       uuid NOT NULL,                 -- the ORIGINAL message
    root_author_id        uuid NOT NULL,                 -- its author (denormalized for fanout)
    parent_message_id     uuid NOT NULL,                 -- the message that was forwarded
    forwarded_message_id  uuid,                          -- always NULL here (no clone is created)
    forwarded_by          uuid NOT NULL,
    forwarded_to          uuid,                          -- always NULL here (target is not a Bliss-Work user)
    forwarded_to_external text,                          -- the target in bare E.164 digits
    platform              text NOT NULL DEFAULT 'blisswork'
                            CHECK (platform IN ('blisswork','whatsapp','slack','teams','gmail','outlook')),
    depth                 int  NOT NULL,
    path                  uuid[] NOT NULL,               -- root..this chain (cycle guard + tree render)
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The columns 0014 added. Kept as separate ALTERs rather than folded into the
-- CREATE above so this file also repairs a database that still has a
-- 0008-shaped table (one where 0018 never ran) instead of silently skipping it —
-- CREATE TABLE IF NOT EXISTS would leave such a table without them.
-- ─────────────────────────────────────────────────────────────────────────────

-- 'confirmed'   — a provider acknowledged the send. Nothing writes this now that
--                 the Business path is gone; it remains the DEFAULT so any
--                 surviving pre-0018 row keeps its original meaning.
-- 'unconfirmed' — we handed the message to the OS and stopped being able to see.
--                 Every row the deep-link path writes is this.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'confirmed';

-- The captured contact's display name, ENCRYPTED under the per-org DEK. It is a
-- third party's personal data, and SECURITY.md §2 puts names in the PII tier, so
-- an org erasure crypto-shreds it with everything else. Nullable: the picker may
-- return a number with no name.
--
-- The inconsistency 0014 recorded is still here: forwarded_to_external (the
-- phone number itself) has been plaintext since 0008. Bringing it under the DEK
-- needs a backfill and is deliberately still not folded in.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS forwarded_to_name_enc bytea;

-- Set when the forwarded message lives in channel_messages rather than messages.
-- Stored rather than derived because message_forwards has no FK on
-- root_message_id (see above), so an id here may belong to either table.
ALTER TABLE message_forwards ADD COLUMN IF NOT EXISTS channel_id uuid;

-- ADD CONSTRAINT has no IF NOT EXISTS and would abort on a re-run, so it is
-- guarded rather than repeated.
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
-- Indexes ─ 0008's, minus the ones only the removed relay justified.
-- ─────────────────────────────────────────────────────────────────────────────

-- "who forwarded my message where": all hops of one original, in order.
CREATE INDEX IF NOT EXISTS idx_forwards_root
    ON message_forwards (root_message_id, depth, created_at);

-- "my forwarding activity": every original I authored that got forwarded.
CREATE INDEX IF NOT EXISTS idx_forwards_root_author
    ON message_forwards (root_author_id, created_at DESC);

-- Chain resolution in resolveLinkProvenance. Partial, because the column is NULL
-- on every row the deep-link path writes — so with the relay gone this indexes
-- nothing and costs nothing, while keeping that lookup from degrading into a
-- sequential scan if clone-writing is ever restored.
CREATE INDEX IF NOT EXISTS idx_forwards_fwd_msg
    ON message_forwards (forwarded_message_id) WHERE forwarded_message_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS ─ declared INLINE, the same org_isolation body 0007_rls.sql applies.
-- ─────────────────────────────────────────────────────────────────────────────
-- 0007 names 'message_forwards' in its org_tables[] loop, but it has already
-- been applied and its checksum is unchanged, so it will NOT re-run to police a
-- table created after it. Without this block the table would come back with no
-- policy at all — readable across orgs. 0008 declared it inline for the same
-- reason; this is that block, unchanged.
--
-- FORCE matters as much as ENABLE: the service connects as the table's owner,
-- and a plain ENABLE does not apply policies to the owning role.
ALTER TABLE message_forwards ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_forwards FORCE  ROW LEVEL SECURITY;
DO $mf$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation'
          AND tablename  = 'message_forwards'
          AND schemaname = current_schema()
    ) THEN
        EXECUTE $pol$
            CREATE POLICY org_isolation ON message_forwards
                USING (
                    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                    OR current_setting('app.bypass_rls', true) = 'on'
                )
                WITH CHECK (
                    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                    OR current_setting('app.bypass_rls', true) = 'on'
                )
        $pol$;
    END IF;
END
$mf$;
