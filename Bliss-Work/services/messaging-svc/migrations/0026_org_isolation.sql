-- 0026_org_isolation.sql — one definition of "this table is org-isolated".
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY
-- boot, so every statement guards re-execution.
--
-- ── The problem this closes ──────────────────────────────────────────────────
-- 0007_rls.sql enumerates a FIXED list of tables and has already run in
-- production, so it can never cover a table added after it. Every migration
-- since has therefore carried its own copy of the same twenty-line incantation
-- — ENABLE, FORCE, look in pg_policies, CREATE POLICY if absent — and by now
-- there are seven copies in this service alone, in five spellings: 0007, 0008,
-- 0010, 0013, 0014_message_features, 0019 and 0023. Repo-wide it is eighteen
-- files across five services.
--
-- They are not all the same. Two of them (0013_channel_blocks and
-- 0014_message_features) check pg_policies WITHOUT `schemaname =
-- current_schema()`, so a same-named policy on a same-named table in any other
-- schema satisfies their guard and the policy is never created. The table is
-- still ENABLE + FORCE, so the result is fail-CLOSED — every query returns zero
-- rows rather than leaking anything — but it is a feature that silently stops
-- working, and the reason would be very hard to find.
--
-- Copying a security-relevant block by hand seven times is how that divergence
-- happened, and it would have happened again on the eighth. So the block gets
-- ONE definition here, and scripts/check-migrations.mjs fails the build if a
-- later migration inlines it again.
--
-- ── Why every service defines its own copy of this function ──────────────────
-- messaging-svc owns its own database. A function lives in exactly one
-- database, so there is no way to share this one across services without
-- coupling their schemas together — the same reason each service carries its
-- own outbox_dead_letter migration. The duplication is a fact of the deployment
-- topology, not a choice.
--
-- ── What this file does NOT do ───────────────────────────────────────────────
-- It does not rewrite the seven existing copies. Migrations are an append-only
-- record: Store.Migrate keys its ledger on filename + checksum, so editing an
-- applied file re-runs it on the next boot AND still never reaches a database
-- that already applied the old text. History stays as it was written; this is
-- the definition everything from here on uses.
--
-- It is also NOT applied to a discovered list of every org_id-bearing table.
-- `calls` and `call_participants` carry `call_access` instead (0015), which
-- admits a cross-org guest who was invited; adding org_isolation beside it
-- would OR a second policy onto a table whose access rule was chosen
-- deliberately. Each table's own migration says which rule it wants.

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

-- ─────────────────────────────────────────────────────────────────────────────
-- Converge the three tables whose original guard was written without the schema
-- filter, so every table ends up on the one definition above.
--
-- A no-op wherever the policy already exists, which is every database that ran
-- 0013 and 0014_message_features against a single-schema install — i.e. all of
-- them. It is a backstop, not a repair: it costs three catalogue lookups on
-- boot and removes the one case where those tables come up with RLS forced and
-- no policy to satisfy it.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT apply_org_isolation('channel_blocks');
SELECT apply_org_isolation('message_hides');
SELECT apply_org_isolation('message_reactions');
