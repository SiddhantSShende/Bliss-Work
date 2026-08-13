-- 0004_mentions.sql — @-mention detection + claim/ignore state. Idempotent;
-- replayed on every boot by db.py::run_migrations, like every file here.
--
-- The hub feed shows ONLY messages where a Bliss-Work user was tagged on a
-- connected platform. Mention-ness is recorded ON the existing provider_activity
-- row rather than in a side table, so the webhook-dedup index
-- `uq_provider_activity_ext (connection_id, external_id_bidx)` stays the SINGLE
-- idempotency guard for the whole inbound path — a replayed webhook or a
-- re-fetched poll page can never mint a second mention for one message.
--
-- provider_identities maps an EXTERNAL handle (a Slack member id, a mailbox
-- address, an AAD object id) to a Bliss-Work user_id. Handles are PII, so they
-- follow the same convention as everything else here: `*_enc` ciphertext under
-- the per-org DEK plus an HMAC `*_bidx` blind index for equality lookup at
-- ingest time (we look handles UP, we never scan them).

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_activity ─ mention + claim state.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE provider_activity
    ADD COLUMN IF NOT EXISTS is_mention              bool NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mention_user_id         uuid,
    ADD COLUMN IF NOT EXISTS mention_state           text,
    ADD COLUMN IF NOT EXISTS claimed_task_id         uuid,
    ADD COLUMN IF NOT EXISTS claimed_by              uuid,
    ADD COLUMN IF NOT EXISTS claimed_at              timestamptz,
    -- Provider deep link + stable thread locator, so a claimed mention's task
    -- can point back at the original message. PII-adjacent → encrypted.
    ADD COLUMN IF NOT EXISTS external_permalink_enc  bytea,
    ADD COLUMN IF NOT EXISTS external_thread_ref_enc bytea;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard on the catalog to keep
-- this file re-runnable. Existing rows all satisfy these (is_mention defaults
-- false with both mention columns NULL), so validation cannot fail on upgrade.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'provider_activity_mention_chk'
    ) THEN
        -- A row is either not a mention (all mention fields NULL) or a mention
        -- with BOTH a state and an owner. No half-populated middle state.
        ALTER TABLE provider_activity ADD CONSTRAINT provider_activity_mention_chk CHECK (
            (is_mention = false AND mention_state IS NULL AND mention_user_id IS NULL)
         OR (is_mention = true  AND mention_state IN ('pending', 'claimed', 'ignored')
                                AND mention_user_id IS NOT NULL)
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'provider_activity_claimed_chk'
    ) THEN
        -- 'claimed' without a task id would strand the user: the UI would show
        -- the mention as done with nothing to open.
        ALTER TABLE provider_activity ADD CONSTRAINT provider_activity_claimed_chk CHECK (
            mention_state IS DISTINCT FROM 'claimed' OR claimed_task_id IS NOT NULL
        );
    END IF;
END $$;

-- The one index the feed needs: "my mentions in state X, newest first".
-- Equality prefix (org_id, mention_user_id, mention_state) + the (occurred_at,
-- id) keyset the cursor pages on. PARTIAL on is_mention so ordinary activity —
-- the overwhelming majority of rows — never enters the index at all.
CREATE INDEX IF NOT EXISTS idx_provider_activity_mentions
    ON provider_activity (org_id, mention_user_id, mention_state, occurred_at DESC, id DESC)
    WHERE is_mention;

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_identities ─ external handle → Bliss-Work user.
--   source='oauth'    → derived from a connected account's own identity, so it
--                       is self-proving: the user completed that OAuth flow.
--   source='declared' → the user typed it in; trusted only within the org, and
--                       overwritten if an OAuth flow later proves the same handle.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_identities (
    id                   uuid PRIMARY KEY,
    org_id               uuid NOT NULL,
    user_id              uuid NOT NULL,
    provider             text NOT NULL
                           CHECK (provider IN ('slack', 'whatsapp', 'gmail', 'outlook', 'teams')),
    handle_kind          text NOT NULL DEFAULT 'account'
                           CHECK (handle_kind IN ('account', 'email', 'phone', 'alias')),
    external_handle_enc  bytea NOT NULL,
    external_handle_bidx bytea NOT NULL,
    source               text NOT NULL DEFAULT 'declared'
                           CHECK (source IN ('oauth', 'declared')),
    connection_id        uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
    verified_at          timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- A handle resolves to AT MOST ONE user per org: two people must not be able to
-- both claim the same mailbox/member id, or a mention would be ambiguous (and
-- one of them could farm the other's mentions into their own task list).
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_identity_handle
    ON provider_identities (org_id, provider, external_handle_bidx);

-- "Which handles do I own?" — the My Handles panel.
CREATE INDEX IF NOT EXISTS idx_provider_identity_user
    ON provider_identities (org_id, user_id, provider);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the new org-bearing table. Same shape as 0002_rls.sql — kept here so
-- this migration is self-contained rather than mutating an already-shipped file.
--
-- NOTE for callers: the webhook receiver and the ingest worker run under
-- `app.bypass_rls`, so every query they make against provider_identities MUST
-- carry an explicit `AND org_id = :org`. RLS is not scoping them.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    t text := 'provider_identities';
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = t
    ) THEN
        RETURN;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'org_isolation' AND tablename = t
    ) THEN
        EXECUTE format(
            'CREATE POLICY org_isolation ON %I '
            'USING ('
            '  org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid '
            '  OR current_setting(''app.bypass_rls'', true) = ''on'''
            ') '
            'WITH CHECK ('
            '  org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid '
            '  OR current_setting(''app.bypass_rls'', true) = ''on'''
            ')',
            t
        );
    END IF;
END $$;
