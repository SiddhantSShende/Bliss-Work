-- 010_task_participants
-- Participant management uses the existing task_assignees table. This migration
-- records the uniqueness guarantee explicitly for deployments created before
-- 001_init included the composite primary key.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'task_assignees_task_id_assignee_id_key'
    ) THEN
        ALTER TABLE task_assignees
            ADD CONSTRAINT task_assignees_task_id_assignee_id_key
            UNIQUE (task_id, assignee_id);
    END IF;
END $$;
