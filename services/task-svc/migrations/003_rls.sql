-- 003_rls.sql: PostgreSQL Row-Level Security — per-org isolation as
-- DEFENSE-IN-DEPTH on top of the existing app-level `WHERE org_id = :org`
-- filters (those stay). Idempotent; safe to run on every boot.
--
-- The per-service DB role OWNS this schema, and table owners BYPASS plain RLS,
-- so we ENABLE *and* FORCE row level security on every org-bearing table.
--
-- Policy: a row is visible/writable only when its org_id matches the
-- transaction-local `app.org_id` GUC, OR the trusted `app.bypass_rls` GUC is
-- 'on' (set ONLY by server code — auth pre-context flows + cross-org workers).
--
--   current_setting(name, true) -> NULL when the GUC is unset. NULL = false in
--   the comparison -> 0 rows. So a handler that forgets to SET the org context
--   FAILS CLOSED (sees nothing) rather than leaking another org's rows.
--
-- ONLY tables that actually carry an org_id column get RLS. Tables WITHOUT one
-- (outbox, consumed_events) get none — there is nothing to scope them by.
--
-- Org-bearing tables (confirmed against 001_init.sql / 002 / 003_column_encryption.sql):
--   tasks, task_assignees, idempotency_keys, org_keys, user_projection
--
-- The CREATE POLICY is guarded by a pg_policies existence check so re-running
-- the migration doesn't error on the already-present policy.

DO $$
DECLARE
    t text;
    org_tables text[] := ARRAY[
        'tasks',
        'task_assignees',
        'idempotency_keys',
        'org_keys',
        'user_projection'
    ];
BEGIN
    FOREACH t IN ARRAY org_tables LOOP
        -- ENABLE + FORCE so even the schema-owning service role is subject to
        -- the policy (owners bypass plain ENABLE-only RLS).
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
