-- 0002: Row-Level Security (RLS) for per-org isolation — DEFENSE IN DEPTH over
-- the app-level `WHERE org_id = :org` filters (those stay).
--
-- Mirrors services/auth-svc/migrations/0003_rls.sql exactly. The per-service DB
-- role OWNS this schema and table owners BYPASS plain RLS, so every org-bearing
-- table is ENABLE *and* FORCE. The policy keys off two transaction-local GUCs
-- set by the app (app/db.py set_org_context / set_bypass_rls):
--   * app.org_id      — the active org for the transaction.
--   * app.bypass_rls  — 'on' for trusted cross-org code only (the Kafka
--                       consumer, the sweeper, the nightly rollup/prune jobs).
--
-- NULLIF(current_setting(...), '') is what makes it FAIL CLOSED on a pooled
-- connection: a prior `SET LOCAL` reverts to '' rather than NULL at COMMIT, and
-- ''::uuid throws. Both NULL and '' collapse to NULL, the comparison is false,
-- and an un-plumbed transaction sees ZERO rows.
--
-- `consumed_events` carries no org_id -> NO RLS, the same exemption auth-svc
-- makes for `outbox` and `refresh_tokens`.
--
-- activity_events is PARTITIONED: a policy on the parent covers every access
-- through the parent, and ensure_activity_partitions() additionally puts the
-- identical policy on each leaf so a direct query against a partition is fenced
-- too. Both are needed — neither implies the other.

-- activity_events
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_events FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'activity_events'
    ) THEN
        CREATE POLICY org_isolation ON activity_events
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- user_sessions
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'user_sessions'
    ) THEN
        CREATE POLICY org_isolation ON user_sessions
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- activity_daily
ALTER TABLE activity_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_daily FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'activity_daily'
    ) THEN
        CREATE POLICY org_isolation ON activity_daily
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- app_usage_daily
ALTER TABLE app_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage_daily FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'app_usage_daily'
    ) THEN
        CREATE POLICY org_isolation ON app_usage_daily
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- site_usage_daily
ALTER TABLE site_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_usage_daily FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'site_usage_daily'
    ) THEN
        CREATE POLICY org_isolation ON site_usage_daily
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- ingest_tokens
ALTER TABLE ingest_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_tokens FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'ingest_tokens'
    ) THEN
        CREATE POLICY org_isolation ON ingest_tokens
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;

-- org_keys
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

