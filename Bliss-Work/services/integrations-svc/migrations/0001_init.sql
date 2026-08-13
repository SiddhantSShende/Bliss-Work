-- integrations-svc schema (idempotent). Owns external-account connections, their
-- encrypted tokens, OAuth CSRF/PKCE state, the unified activity mirror, and the
-- raw inbound-webhook audit log.
--
-- Sensitive values (OAuth access/refresh tokens, external account ids, message
-- bodies, PKCE verifiers) are stored as `*_enc bytea` — self-describing
-- AES-256-GCM ciphertext under the per-org DEK (see app/crypto.py). `*_bidx`
-- columns are HMAC blind indexes for equality lookup on encrypted values.

-- ─────────────────────────────────────────────────────────────────────────────
-- org_keys ─ per-org wrapped DEKs for the Cryptor. IDENTICAL shape to task-svc /
-- auth-svc / messaging-svc so the shared key-rotation tooling works uniformly.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_keys (
    org_id      uuid        NOT NULL,
    key_version smallint    NOT NULL,
    wrapped_dek bytea       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,
    PRIMARY KEY (org_id, key_version)
);
CREATE INDEX IF NOT EXISTS idx_org_keys_current
    ON org_keys (org_id) WHERE retired_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- integration_connections ─ one connected external account.
--   owner_user_id NULL + scope_kind='org'  → workspace-wide (e.g. a Slack bot)
--   owner_user_id set  + scope_kind='user' → a single user's account (e.g. Gmail)
-- Tokens NEVER leave this table unencrypted and are never serialized to clients.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_connections (
    id                       uuid PRIMARY KEY,
    org_id                   uuid NOT NULL,
    owner_user_id            uuid,
    scope_kind               text NOT NULL DEFAULT 'user'
                               CHECK (scope_kind IN ('user','org')),
    provider                 text NOT NULL
                               CHECK (provider IN ('slack','whatsapp','gmail','outlook','teams')),
    status                   text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','connected','error','revoked')),
    display_label            text NOT NULL DEFAULT '',
    external_account_id_enc  bytea,
    external_account_id_bidx bytea,
    access_token_enc         bytea,
    refresh_token_enc        bytea,
    token_expires_at         timestamptz,
    scopes                   text[] NOT NULL DEFAULT '{}',
    metadata_enc             bytea,
    last_error               text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);
-- One connection per (org, provider, external account). The blind index is NULL
-- until an account is resolved, so the uniqueness only covers resolved accounts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_conn_account
    ON integration_connections (org_id, provider, external_account_id_bidx)
    WHERE external_account_id_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_conn_owner
    ON integration_connections (org_id, owner_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- oauth_states ─ short-TTL CSRF + PKCE state for authorization-code flows.
-- Unknown / expired state at the callback → reject (fail closed).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_states (
    state             text PRIMARY KEY,
    org_id            uuid NOT NULL,
    owner_user_id     uuid NOT NULL,
    provider          text NOT NULL,
    code_verifier_enc bytea,
    redirect_after    text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_activity ─ unified hub mirror of inbound + outbound messages/calls/
-- emails across connected platforms. body/peer are PII → encrypted.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_activity (
    id               uuid PRIMARY KEY,
    org_id           uuid NOT NULL,
    owner_user_id    uuid,
    connection_id    uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    provider         text NOT NULL,
    direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),
    kind             text NOT NULL CHECK (kind IN ('message','call','email')),
    external_id_bidx bytea,
    peer_enc         bytea,
    body_enc         bytea,
    status           text,
    occurred_at      timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now()
);
-- Webhook idempotency: an inbound event id maps to at most one activity row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_activity_ext
    ON provider_activity (connection_id, external_id_bidx)
    WHERE external_id_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_activity_owner
    ON provider_activity (org_id, owner_user_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- webhook_events ─ inbound dedup + audit. Written by the PUBLIC webhook receiver
-- BEFORE org context is known, so it carries NO org_id and gets NO RLS (like
-- outbox). It records THAT an event arrived and whether its signature verified,
-- never the payload — see 0007 for why the payload column was dropped.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
    id                 uuid PRIMARY KEY,
    provider           text NOT NULL,
    external_event_id  text,
    signature_verified bool NOT NULL DEFAULT false,
    received_at        timestamptz NOT NULL DEFAULT now(),
    processed_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_ext
    ON webhook_events (provider, external_event_id)
    WHERE external_event_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Transactional outbox + consumer dedup (for the integration.events.v1 topic the
-- hub emits when new activity lands — wired with the provider layer).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox (
    id           uuid PRIMARY KEY,
    topic        text NOT NULL,
    kafka_key    text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS consumed_events (
    event_id    uuid PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);
