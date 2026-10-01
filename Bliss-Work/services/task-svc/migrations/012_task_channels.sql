-- 012_task_channels — a task can be allocated to several channels, alongside
-- explicitly named people.
--
-- Until now a task carried ONE optional channel (`tasks.channel_id`) and, at
-- creation, was either "these people" or "this channel". The New Task form now
-- lets one submission name people AND any number of channels, and that must stay
-- ONE task whose channels remain real channel relationships (a member who joins a
-- channel later is added to the task — see consumer._handle_channel_member_joined).
--
--   task_channels      the authoritative task <-> channel relation, one row per
--                      channel. (task_id, channel_id) is the key, so a channel can
--                      never be attached twice.
--   task_schedules     deferred/recurring tasks are a TEMPLATE that has not become
--                      a task yet, so they carry the picked channels as an array,
--                      mirroring how the same row already carries `assignee_ids`.
--                      Each occurrence copies them into task_channels.
--
-- Who is ON a task is unchanged: task_assignees, keyed (task_id, assignee_id), so
-- a person who is both named and a member of a named channel is one row.
--
-- The single-valued `tasks.channel_id` / `task_schedules.channel_id` columns stay
-- and now hold the FIRST channel only. Nothing reads them as the source of truth
-- any more except as a fallback for rows written before this migration; they are
-- kept so rolling the service back to the previous release still fans a task out
-- to its first channel instead of losing the link. Drop them once that is no
-- longer a concern.

CREATE TABLE IF NOT EXISTS task_channels (
    task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    org_id     uuid NOT NULL,
    channel_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, channel_id)
);

-- The retroactive lookup is "every task allocated to channel X" (same shape as
-- idx_tasks_channel, which this supersedes for new rows).
CREATE INDEX IF NOT EXISTS idx_task_channels_channel ON task_channels (org_id, channel_id);

-- Existing single-channel tasks become one row each. Re-running is a no-op.
INSERT INTO task_channels (task_id, org_id, channel_id)
SELECT id, org_id, channel_id FROM tasks WHERE channel_id IS NOT NULL
ON CONFLICT DO NOTHING;

SELECT apply_org_isolation('task_channels');

ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS channel_ids uuid[] NOT NULL DEFAULT '{}';

UPDATE task_schedules SET channel_ids = ARRAY[channel_id]
WHERE channel_id IS NOT NULL AND cardinality(channel_ids) = 0;

-- 011's "a target is required" CHECK only knows the single channel column. It was
-- declared inline, so its name was generated: find it by what it says.
DO $$
DECLARE c record;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'task_schedules'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%channel_id IS NOT NULL%'
          AND pg_get_constraintdef(oid) NOT ILIKE '%channel_ids%'
    LOOP
        EXECUTE format('ALTER TABLE task_schedules DROP CONSTRAINT %I', c.conname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'task_schedules'::regclass AND conname = 'task_schedules_has_target'
    ) THEN
        ALTER TABLE task_schedules ADD CONSTRAINT task_schedules_has_target
            CHECK (channel_id IS NOT NULL
                OR cardinality(channel_ids) > 0
                OR cardinality(assignee_ids) > 0);
    END IF;
END $$;
