-- 009_org_isolation — one definition of "this table is org-isolated".
--
-- This migration is IDEMPOTENT. run_migrations re-Execs every file whose
-- checksum changed and skips the rest, and every statement here guards
-- re-execution regardless.
--
-- ── The problem this closes ──────────────────────────────────────────────────
-- 003_rls.sql enumerates a FIXED list of tables and has already run in production,
-- so it can never cover a table added after it. Every migration since that
-- needed RLS has therefore carried its own copy of the same block — ENABLE,
-- FORCE, look in pg_policies, CREATE POLICY if absent.
--
-- Across the whole repo that block had been pasted into eighteen migration
-- files in five services, and the copies had already diverged: two of
-- messaging-svc's dropped `schemaname = current_schema()` from the pg_policies
-- guard, so a same-named policy in any other schema satisfies the guard and the
-- policy is never created. The table is still ENABLE + FORCE, so that fails
-- CLOSED — every query returns zero rows rather than leaking anything — but it
-- is a feature that silently stops working for a reason nobody would find.
--
-- Copying a security-relevant block by hand is what caused that, so it gets ONE
-- definition per database here. scripts/check-migrations.mjs fails the build if
-- a later migration in this service inlines the block again.
--
-- ── Why every service defines its own copy of this function ──────────────────
-- task-svc owns its own database. A function lives in exactly one database, so
-- there is no way to share this one across services without coupling their
-- schemas together — the same reason each service carries its own
-- outbox_dead_letter migration. The duplication here is a fact of the
-- deployment topology, not a choice.
--
-- ── What this file does NOT do ───────────────────────────────────────────────
-- It does not rewrite the existing copies or touch a single policy. Migrations
-- are an append-only record: run_migrations keys its ledger on filename +
-- checksum, so editing an applied file re-runs it on the next boot AND still
-- never reaches a database that already applied the old text. History stays as
-- written; this is the definition everything from here on uses.

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
