-- 0002_rls.sql: PostgreSQL Row-Level Security — per-org isolation as
-- DEFENSE-IN-DEPTH on top of the app-level `WHERE org_id = :org` filters.
-- Idempotent; safe to run on every boot. Mirrors task-svc/003_rls.sql.
--
-- ENABLE *and* FORCE on every org-bearing table (the service role owns the schema
-- and would otherwise bypass plain ENABLE-only RLS). Policy: a row is visible/
-- writable only when its org_id matches the transaction-local `app.org_id` GUC,
-- OR the trusted `app.bypass_rls` GUC is 'on' (set ONLY by server code — the
-- public webhook receiver resolves a connection by blind index under bypass, then
-- scopes work to that connection's org_id).
--
-- current_setting(name, true) -> NULL when unset -> 0 rows: a handler that forgets
-- SET app.org_id FAILS CLOSED rather than leaking another org's rows.
--
-- webhook_events has NO org_id (written pre-org-context) and gets NO RLS, like
-- outbox / consumed_events.

DO $$
DECLARE
    t text;
    org_tables text[] := ARRAY[
        'org_keys',
        'integration_connections',
        'oauth_states',
        'provider_activity'
    ];
BEGIN
    FOREACH t IN ARRAY org_tables LOOP
        -- Defensive: skip if a table somehow isn't present yet (all are created
        -- by 0001_init.sql, which runs first in the same startup).
        IF NOT EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = current_schema() AND tablename = t
        ) THEN
            CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE policyname = 'org_isolation' AND tablename = t
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
    END LOOP;
END $$;
