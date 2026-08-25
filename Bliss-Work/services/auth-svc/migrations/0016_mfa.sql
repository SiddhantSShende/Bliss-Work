-- 0016: MFA (TOTP + WebAuthn), opt-in + org-admin-mandatory with a grace
-- period. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.
--
-- Storage lives on `users` (per org-membership), not `identities`: `identities`
-- has no per-identity encryption mechanism today, while `users` already has the
-- only existing encrypted-column convention (email_enc/email_bidx) via the
-- shared Cryptor class, which is strictly per-org (org_id is the AAD).
-- Accepted consequence: a user with two org memberships enrolls TOTP/WebAuthn
-- twice — consistent with MFA policy itself being an org-admin setting.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS mfa_totp_secret_enc   bytea,
    -- Distinct from mfa_enrolled_at: the last successfully-consumed 30s
    -- time-step counter, checked-and-updated atomically under FOR UPDATE (see
    -- mfa_service.verify_totp_replay_safe) so a captured code can't be
    -- replayed even by two concurrent requests racing each other.
    ADD COLUMN IF NOT EXISTS mfa_totp_last_counter bigint,
    ADD COLUMN IF NOT EXISTS mfa_enrolled          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mfa_enrolled_at       timestamptz;

ALTER TABLE orgs
    ADD COLUMN IF NOT EXISTS require_mfa_for_admins   boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mfa_grace_period_ends_at timestamptz;

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id),
    org_id     uuid NOT NULL,
    code_hash  bytea UNIQUE NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user ON mfa_backup_codes (user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_org  ON mfa_backup_codes (org_id);

CREATE TABLE IF NOT EXISTS mfa_webauthn_credentials (
    id             uuid PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES users(id),
    org_id         uuid NOT NULL,
    credential_id  bytea UNIQUE NOT NULL,
    public_key     bytea NOT NULL,
    sign_count     bigint NOT NULL DEFAULT 0,
    nickname       text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mfa_webauthn_credentials_user ON mfa_webauthn_credentials (user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_webauthn_credentials_org  ON mfa_webauthn_credentials (org_id);

-- RLS via the one shared definition (migrations/0013_org_isolation.sql) —
-- copying the policy block by hand is exactly how two earlier copies lost
-- their schemaname guard; scripts/check-migrations.mjs enforces this.
SELECT apply_org_isolation('mfa_backup_codes');
SELECT apply_org_isolation('mfa_webauthn_credentials');

-- user_tokens gains two more purposes, both server-only (never emailed): the
-- "MFA pending" token minted after a correct password when a second factor
-- is still owed, and the WebAuthn ceremony challenge (a random byte string is
-- exactly what user_tokens already mints as its "raw" secret, so a ceremony
-- challenge reuses this table instead of a new one — see
-- mfa_service.mint_webauthn_challenge). The existing mint_token/consume_token
-- machinery is purpose-agnostic; only this CHECK constraint needs widening.
ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_purpose_chk;
ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_purpose_chk
    CHECK (purpose IN ('password_reset', 'email_verify', 'mfa_pending', 'webauthn_challenge'));
