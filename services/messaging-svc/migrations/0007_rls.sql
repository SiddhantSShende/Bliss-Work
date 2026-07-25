-- 0007_rls.sql — PostgreSQL Row-Level Security for per-org isolation.
--
-- DEFENSE-IN-DEPTH only. The application keeps every existing `WHERE org_id = $1`
-- filter; RLS is the second wall that catches a query that ever forgets one (or
-- a cross-org id smuggled past the app layer). The two are belt + suspenders.
--
-- This migration is IDEMPOTENT. ENABLE/FORCE are no-ops when already set, and
-- every CREATE POLICY is guarded by a pg_policies existence check.
--
-- ── Why FORCE, not just ENABLE ────────────────────────────────────────────────
-- The per-service DB role OWNS these tables. Plain ENABLE ROW LEVEL SECURITY is
-- *bypassed* by the table owner (and any BYPASSRLS role). messaging-svc connects
-- as the owner, so without FORCE the policies would never apply. FORCE makes the
-- owner subject to RLS too — which is exactly what we want.
--
-- ── The policy ────────────────────────────────────────────────────────────────
-- USING / WITH CHECK both pass iff:
--   * the row's org_id equals the per-transaction GUC app.org_id, OR
--   * app.bypass_rls = 'on' (set ONLY by trusted server code: pre-org-context
--     auth flows and cross-org background workers — never from request input).
--
-- current_setting(name, true) returns NULL when the GUC is unset; NULL = uuid is
-- NULL (not true), so an org-scoped connection that forgot to SET app.org_id
-- sees ZERO rows and writes are rejected. FAIL-CLOSED by construction.
--
-- ── Partitioned tables ────────────────────────────────────────────────────────
-- inbox_items (HASH-partitioned by owner_user_id, 64 partitions) and messages
-- are referenced by their PARENT only. ENABLE/FORCE ROW LEVEL SECURITY and a
-- POLICY declared on a partitioned parent apply to every partition, so we never
-- touch the inbox_items_pNN children directly. (messages is NOT partitioned in
-- this schema, but the same statement form is used for uniformity.)

DO $rls$
DECLARE
    t text;
    -- Every table in messagingdb that carries an org_id column. Tables WITHOUT
    -- org_id are intentionally excluded and get NO RLS:
    --   outbox, consumed_events, consumed_events_inbox_tasks,
    --   message_delivery (parent `messages` is already RLS-protected),
    --   idempotency_keys.
    org_tables text[] := ARRAY[
        'conversations',
        'conversation_members',
        'messages',
        'channels',
        'channel_members',
        'channel_messages',
        'channel_member_history',
        'threads',
        'thread_members',
        'inbox_items',
        'message_forwards',
        'org_keys',
        'user_projection'
    ];
BEGIN
    FOREACH t IN ARRAY org_tables LOOP
        -- Skip cleanly if a table somehow isn't present (defensive; all of these
        -- are created by earlier migrations in this same run).
        IF NOT EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = current_schema() AND tablename = t
        ) THEN
            CONTINUE;
        END IF;

        -- ENABLE + FORCE (idempotent — re-running just re-asserts the flags).
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        -- Guarded policy creation: CREATE POLICY has no IF NOT EXISTS, so check
        -- pg_policies first and only create when our policy is absent.
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE policyname = 'org_isolation'
              AND tablename  = t
              AND schemaname = current_schema()
        ) THEN
            EXECUTE format($pol$
                CREATE POLICY org_isolation ON %I
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    WITH CHECK (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
            $pol$, t);
        END IF;
    END LOOP;
END
$rls$;
