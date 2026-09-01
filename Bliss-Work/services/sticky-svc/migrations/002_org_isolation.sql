-- 002_org_isolation — one definition of "this table is org-isolated".
--
-- This migration is IDEMPOTENT. run_migrations re-Execs every file whose
-- checksum changed and skips the rest, and every statement here guards
-- re-execution regardless.
--
-- ── Why this service carries its own copy ────────────────────────────────────
-- sticky-svc owns its own database (stickydb). A Postgres function lives in
-- exactly one database, so there is no way to share task-svc's copy without
-- coupling the two schemas together — the same reason each service carries its
-- own outbox_dead_letter migration. The duplication is a fact of the
-- deployment topology, not a choice, and the function body below is deliberately
-- byte-identical to services/task-svc/migrations/009_org_isolation.sql.
--
-- scripts/check-migrations.mjs fails the build if a later migration in this
-- service inlines the policy block instead of calling this.

-- ─────────────────────────────────────────────────────────────────────────────
-- apply_org_isolation ─ make one table org-isolated, idempotently.
--
--   • ENABLE *and* FORCE, because the service role owns these tables and RLS
--     would otherwise not apply to it.
--   • The pg_policies guard is schema-qualified — CREATE POLICY has no
--     IF NOT EXISTS, and an unqualified check is the bug described above.
--   • The predicate fails closed: an unset app.org_id sees nothing, which makes
--     a forgotten SET LOCAL a visible bug rather than a silent leak.
--
-- `org_column` exists for the org table itself, which carries the id in `id`
-- rather than `org_id`. It is quoted with %I like the table name, so it can
-- never carry SQL in from a caller.
--
-- SECURITY INVOKER (the default) is correct and intentional: this only issues
-- DDL, and it must run as whoever is migrating rather than handing anyone a
-- way to attach policies later.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION apply_org_isolation(
    target_table text,
    org_column   text DEFAULT 'org_id'
) RETURNS void AS $fn$
BEGIN
    -- A table that is not there yet is not an error, it is a migration that has
    -- not run.
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = current_schema() AND tablename = target_table
    ) THEN
        RETURN;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target_table);

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation'
          AND tablename  = target_table
          AND schemaname = current_schema()
    ) THEN
        EXECUTE format(
            'CREATE POLICY org_isolation ON %I'
            '    USING ('
            '        %I = NULLIF(current_setting(''app.org_id'', true), '''')::uuid'
            '        OR current_setting(''app.bypass_rls'', true) = ''on'''
            '    )'
            '    WITH CHECK ('
            '        %I = NULLIF(current_setting(''app.org_id'', true), '''')::uuid'
            '        OR current_setting(''app.bypass_rls'', true) = ''on'''
            '    )',
            target_table, org_column, org_column);
    END IF;
END
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apply_org_isolation(text, text) IS
    'Attach the standard org_isolation RLS policy to one table, idempotently. '
    'New migrations that add an org-bearing table MUST call this rather than '
    'copying the policy block — enforced by scripts/check-migrations.mjs.';


-- ── Apply it ─────────────────────────────────────────────────────────────────
-- sticky_pins carries org_id and is read by request handlers, so it MUST be
-- isolated: a handler that forgets set_org_context sees zero rows rather than
-- another org's pins.
SELECT apply_org_isolation('sticky_pins');

-- consumed_events is deliberately NOT isolated. It holds Kafka event ids and no
-- org column at all, and is written only by the cross-org consumer (which runs
-- under set_bypass_rls). Same treatment as task-svc's equivalent.
