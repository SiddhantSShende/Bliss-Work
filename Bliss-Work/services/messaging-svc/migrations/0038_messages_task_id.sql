-- 0038_messages_task_id.sql — messages.task_id, the DM twin of
-- channel_messages.task_id (0036_channel_messages_task_id.sql): tags a DM
-- message sent through a task's "Chat" entry point with the task it's about.
--
-- This migration is IDEMPOTENT. Store.Migrate re-runs every file against the
-- applied-migrations ledger, so every statement guards re-execution.
--
-- No FK (task_id is task-svc's, opaque here — same reasoning as
-- channel_messages.task_id). The composite index mirrors 0036's: it backs a
-- per-task unread/lookup query scoped to one conversation.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS task_id uuid;

CREATE INDEX IF NOT EXISTS idx_messages_conv_task_seq
    ON messages (conversation_id, task_id, seq);
