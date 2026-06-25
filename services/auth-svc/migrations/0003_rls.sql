-- 0003: Row-Level Security (RLS) for per-org isolation — DEFENSE IN DEPTH over
-- the existing app-level `WHERE org_id = :org` filters (those stay).
--
-- The per-service DB role OWNS this schema; table owners BYPASS plain RLS, so we
-- ENABLE *and* FORCE RLS on every org-bearing table. The policy keys off two
-- transaction-local GUCs set by the app (see app/service.py set_org_guc /
-- set_bypass_rls):
--   * app.org_id      — the active org for the transaction.
--   * app.bypass_rls  — 'on' for trusted pre-org-context / cross-org code only.
--
-- current_setting(name, true) returns NULL when the GUC was never set, but on a
-- POOLED connection a prior `SET LOCAL app.org_id=...` reverts to an empty string
-- '' at COMMIT (not NULL), and ''::uuid throws. So we wrap in NULLIF(...,'') —
-- both NULL and '' become NULL, the org_id comparison is then false, and an
-- un-plumbed transaction sees ZERO rows — FAIL CLOSED. Each CREATE POLICY is
-- guarded by a pg_policies existence check so this migration stays idempotent.
--
-- Only tables that actually carry org_id get RLS. `orgs` is keyed by its own
-- `id`. `roles`, `refresh_tokens` and `outbox` have no org_id -> NO RLS.

-- orgs (org key = id)
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'orgs'
    ) THEN
        CREATE POLICY org_isolation ON orgs
            USING      (id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'users'
    ) THEN
        CREATE POLICY org_isolation ON users
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- user_roles
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'user_roles'
    ) THEN
        CREATE POLICY org_isolation ON user_roles
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- invites
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'invites'
    ) THEN
        CREATE POLICY org_isolation ON invites
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- audit_log
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'audit_log'
    ) THEN
        CREATE POLICY org_isolation ON audit_log
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- org_keys (per-org wrapped DEKs; read/written transparently by crypto.py)
ALTER TABLE org_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_keys FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'org_keys'
    ) THEN
        CREATE POLICY org_isolation ON org_keys
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;
