-- 0036_channel_messages_task_id.sql — channel_messages.task_id, so a message
-- sent through a task's "Chat" entry point can be tagged with the task it's
-- about (see 0035_task_discussions.sql).
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY
-- boot, so every statement guards re-execution.
--
-- No FK (task_id is task-svc's, opaque here — same reasoning as
-- channel_messages.reply_to_id in 0031). The composite index backs the
-- per-task unread count: messages in channel X about task Y, newer than my
-- last_read_seq, not sent by me.
ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS task_id uuid;

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_task_seq
    ON channel_messages (channel_id, task_id, seq);
