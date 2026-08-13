-- 0005_app_credentials.sql — per-org OAuth apps + per-connection webhook URLs.
-- Idempotent; replayed on every boot by db.py::run_migrations, like every file here.
--
-- WHY THIS EXISTS
-- ───────────────
-- Integrations are user-driven: each org brings its OWN third-party app rather
-- than authorizing a central Bliss-Work one. Until now `providers/oauth.py`
-- read GOOGLE_CLIENT_ID / MS_CLIENT_ID from server env, which meant one shared
-- app for every tenant — the opposite of that model, and a Google verification
-- liability besides (one app's restricted-scope review would gate everyone).
--
-- Two tables' worth of change:
--   1. provider_app_credentials — an org's own OAuth client id/secret.
--   2. integration_connections.webhook_token — a per-connection webhook URL, so
--      Slack's url_verification handshake and WhatsApp's hub.challenge can
--      resolve a connection BEFORE trusting any payload. Both handshakes carry
--      no account identifier (Slack's url_verification has no team_id at all),
--      so today they can only be answered from a SERVER-level secret. That is
--      the last thing forcing a shared credential, and the path token removes it.
--
-- Server env stays supported as an optional FALLBACK so a self-hosted single-
-- tenant deployment can still supply one central app; org credentials win.

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_app_credentials ─ one OAuth app per (org, vendor).
--
-- Keyed by VENDOR, not provider: outlook and teams are both Microsoft Graph and
-- share one Entra app registration, so an org registers Microsoft once and gets
-- both. Splitting them would force the user to create two identical app
-- registrations and keep them in sync.
--
-- client_id is not secret (it appears in the authorize URL the browser follows)
-- but is encrypted anyway — it is an org identifier at a third party, the column
-- costs nothing extra, and it keeps one rule for this table rather than two.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_app_credentials (
    id                uuid PRIMARY KEY,
    org_id            uuid NOT NULL,
    vendor            text NOT NULL CHECK (vendor IN ('google', 'microsoft')),
    client_id_enc     bytea NOT NULL,
    client_secret_enc bytea NOT NULL,
    -- Microsoft only: the Entra tenant id, or 'common' for multi-tenant apps.
    -- Google has no equivalent, so it stays NULL there.
    tenant            text,
    -- Google only: the Pub/Sub topic that users.watch pushes to. Collected here
    -- alongside the client credentials because it belongs to the same Cloud
    -- project and is useless without them.
    pubsub_topic      text,
    created_by        uuid NOT NULL,
    updated_by        uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One app per vendor per org. The connect flow looks credentials up by
-- (org, vendor) and must never have to choose between two rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_app_cred_org_vendor
    ON provider_app_credentials (org_id, vendor);

-- ─────────────────────────────────────────────────────────────────────────────
-- oauth_states.app_credential_id ─ pin the flow to the app that started it.
--
-- Without this, a callback resolves credentials by (org, vendor) again at
-- redeem time. If an admin rotates the client secret while a user is mid-
-- consent, the code would be exchanged against the NEW secret and fail with an
-- opaque invalid_client. ON DELETE SET NULL rather than CASCADE: losing the
-- pin degrades to the old behavior, whereas cascading would delete a live
-- in-flight state and turn a credential edit into a failed login.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS app_credential_id uuid
        REFERENCES provider_app_credentials(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- integration_connections.webhook_token ─ per-connection webhook URL.
--
-- The provider is told to POST to /ext/{provider}/webhook/{webhook_token}, so
-- the connection is identified by the PATH before the body is parsed. That is
-- what lets a per-connection signing secret verify the very first request,
-- including handshakes that carry no account id.
--
-- The token is an opaque random string, NOT a secret that authenticates the
-- request on its own — the provider's HMAC signature still does that, and is
-- still required. The token only answers "which connection is this for?".
-- It is stored in plaintext because it must be looked up by equality on an
-- unauthenticated path, before any org context exists to decrypt under.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS webhook_token text;

-- Globally unique: the lookup happens with no org context (a public path), so
-- the token alone has to identify exactly one row. Partial, because existing
-- connections have none until they are re-saved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_conn_webhook_token
    ON integration_connections (webhook_token)
    WHERE webhook_token IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the new org-bearing table. Same shape as 0002_rls.sql / 0004.
--
-- NOTE for callers: the OAuth callback and every webhook path run under
-- `app.bypass_rls`, so their queries against provider_app_credentials MUST
-- carry an explicit `AND org_id = :org`. RLS is not scoping them.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    t text := 'provider_app_credentials';
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
