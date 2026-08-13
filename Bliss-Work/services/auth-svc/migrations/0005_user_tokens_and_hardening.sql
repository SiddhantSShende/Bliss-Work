-- 0005: single-use email tokens (password reset + email verification) and
-- login-hardening columns on users. Idempotent; re-executed on every startup
-- (see app/db.py run_migrations — the whole file runs via the asyncpg
-- simple-query protocol, so multiple statements in one script are fine).

-- ── Unified single-use token table (password reset + email verification) ─────
-- Mirrors `invites`: the raw token is emailed exactly once and only its
-- SHA-256 is persisted (token_hash bytea UNIQUE), so a DB compromise never
-- yields a usable link. `purpose` distinguishes the two flows so one table and
-- one validate/consume code path serve both. RLS-isolated per org like every
-- other org-bearing table (policy mirrors 0003_rls.sql).
CREATE TABLE IF NOT EXISTS user_tokens (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL,
    user_id     uuid NOT NULL,
    purpose     text NOT NULL,                    -- 'password_reset' | 'email_verify'
    token_hash  bytea UNIQUE NOT NULL,
    status      text NOT NULL DEFAULT 'pending',  -- 'pending' | 'used'
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_tokens_purpose_chk CHECK (purpose IN ('password_reset', 'email_verify'))
);
-- Lookup by (user, purpose) is used to invalidate a user's outstanding tokens
-- when a new one is minted; org index backs the RLS-scoped scans.
CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_user_tokens_org  ON user_tokens (org_id);

ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tokens FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'user_tokens'
    ) THEN
        CREATE POLICY org_isolation ON user_tokens
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- ── Login-hardening columns on users ────────────────────────────────────────
-- Account-lockout state, checked and updated transactionally inside the login
-- path (shared DB → honest across pods without any extra dependency).
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Email verification. DEFAULT true so every pre-existing row (already trusted
-- in production) is backfilled verified and cannot be locked out by the new
-- gate; NEW signups insert `false` explicitly (see create_org), and
-- invite-accepted users keep the true default (they proved mailbox control by
-- following the emailed invite link).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;
