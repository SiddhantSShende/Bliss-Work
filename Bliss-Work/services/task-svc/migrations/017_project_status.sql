-- 017_project_status — a project's own lifecycle: ACTIVE until its creator (or
-- an org_admin) marks it COMPLETED once every task in it is done.
--
-- Purely additive: every new column is nullable or carries a default, so a
-- project written before this migration is simply ACTIVE, exactly what it
-- always was.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS completed_by uuid NULL;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'projects'::regclass AND conname = 'projects_status_check'
    ) THEN
        ALTER TABLE projects ADD CONSTRAINT projects_status_check
            CHECK (status IN ('ACTIVE', 'COMPLETED'));
    END IF;
END $$;
