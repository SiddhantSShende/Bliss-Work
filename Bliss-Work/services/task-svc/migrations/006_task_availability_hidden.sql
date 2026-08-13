-- 006_task_availability_hidden.sql — org-admin curation of the "Available" roster.
--
-- Idempotent (safe to run on every boot).
--
-- The Available bucket is DERIVED — a member is available when they hold zero
-- ACKNOWLEDGED task_assignees rows — so there is nothing to persist about
-- availability itself. The only durable state is an org admin's decision to hide
-- a specific user from that roster: one row per hidden (org, user). Deleting the
-- row un-hides.
--
-- No FK to user_projection: that projection is fed by `user.created` only (see
-- app/consumer.py) and is therefore incomplete. A stale row for a departed user
-- is harmless — the client joins this set against the auth-svc directory, so an
-- id with no directory entry simply never renders.
--
-- No index beyond the PK: every access is `WHERE org_id = :org` or the full key.

CREATE TABLE IF NOT EXISTS availability_hidden (
    org_id    uuid        NOT NULL,
    user_id   uuid        NOT NULL,
    hidden_by uuid        NOT NULL,
    hidden_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);

-- RLS: 003_rls.sql enumerates a FIXED table list and has already run, so it will
-- never cover a table added later. This org-bearing table installs the identical
-- `org_isolation` policy itself. ENABLE *and* FORCE so the schema-owning service
-- role is subject to it too (owners bypass plain ENABLE-only RLS).
ALTER TABLE availability_hidden ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_hidden FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'availability_hidden'
    ) THEN
        CREATE POLICY org_isolation ON availability_hidden
            USING (
              org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.bypass_rls', true) = 'on'
            )
            WITH CHECK (
              org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.bypass_rls', true) = 'on'
            );
    END IF;
END $$;
