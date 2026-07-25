-- 0008_forwards.sql — internal-relay forward-tracking provenance (additive).
--
-- This migration is IDEMPOTENT. Every statement guards re-execution.
--
-- Feature: when B forwards A's message to C, the message C actually receives is a
-- normal cloned `messages` row (carrying is_forward + forwarded_from_message_id)
-- that rides its own MessageCreated. Separately, ONE row is written to
-- message_forwards recording the provenance edge, referencing the ROOT message so
-- the original author A can query the whole downstream forward tree in a single
-- index scan and be notified live (via the message.forwarded event).
--
-- Edges reference the root (not a self-join on messages) because A must see the
-- entire tree of one original message: `WHERE root_message_id = $1 ORDER BY depth`
-- returns every hop. parent_message_id + depth reconstruct the tree; path (the
-- root..this chain of message ids) gives cycle detection + renderable ancestry;
-- root_author_id is denormalized so the ws-gateway routes the event to A with no
-- DB lookup and "my forwarding activity" is one index scan.
--
-- Conventions (mirrors 0003):
--  * uuid PK generated APP-SIDE (uuidv7).
--  * additive columns on `messages` are NULLABLE / DEFAULTed — never NOT NULL on
--    the existing table.

-- ─────────────────────────────────────────────────────────────────────────────
-- message_forwards ─ one row per forward hop.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_forwards (
    id                    uuid PRIMARY KEY,              -- uuidv7, app-side
    org_id                uuid NOT NULL,
    root_message_id       uuid NOT NULL,                 -- A's ORIGINAL message
    root_author_id        uuid NOT NULL,                 -- A (denormalized; fanout never joins)
    parent_message_id     uuid NOT NULL,                 -- the message that was forwarded (= root on hop 1)
    forwarded_message_id  uuid,                          -- the NEW cloned message delivered to C (NULL when external)
    forwarded_by          uuid NOT NULL,                 -- B
    forwarded_to          uuid,                          -- C (Bliss-Work user); NULL when external
    forwarded_to_external text,                          -- external handle when platform != 'blisswork'
    platform              text NOT NULL DEFAULT 'blisswork'
                            CHECK (platform IN ('blisswork','whatsapp','slack','teams','gmail','outlook')),
    depth                 int  NOT NULL,                 -- hop number (1 = the author's message forwarded once)
    path                  uuid[] NOT NULL,               -- root..this chain of message ids (cycle guard + tree render)
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- A's "who forwarded my message where" query: all hops of one original, in order.
CREATE INDEX IF NOT EXISTS idx_forwards_root
    ON message_forwards (root_message_id, depth, created_at);

-- "My forwarding activity" feed — every original I authored that got forwarded.
CREATE INDEX IF NOT EXISTS idx_forwards_root_author
    ON message_forwards (root_author_id, created_at DESC);

-- Provenance lookup when forwarding an already-forwarded message (next hop).
CREATE INDEX IF NOT EXISTS idx_forwards_fwd_msg
    ON message_forwards (forwarded_message_id) WHERE forwarded_message_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- messages ─ additive back-pointers marking a cloned forward (NULLABLE/DEFAULTED).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_forward bool NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS ─ declared INLINE here (same org_isolation policy body as 0007_rls.sql) so
-- message_forwards is protected even before 0007 re-runs. 0007's org_tables[]
-- also lists 'message_forwards' for documentation; both are idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
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
