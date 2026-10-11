-- 0035_task_discussions.sql — task_discussions: the durable link between a
-- task-svc task and the messaging-svc conversation/thread or channel its
-- "Chat" button opens.
--
-- This migration is IDEMPOTENT and ADDITIVE. Store.Migrate re-Execs every file
-- on EVERY boot, so every statement guards re-execution, and old and new
-- replicas can run side by side during a rollout.
--
-- task_id is OPAQUE: task-svc owns tasks, messaging-svc owns conversations and
-- channels, and the two services do not share a database — same convention as
-- task_channels.channel_id / tasks.channel_id referencing the other direction.
-- No FK, no cross-service join.
--
-- kind decides which of conversation_id/thread_id/channel_id is populated:
--   DM      conversation_id is set immediately (OpenConversation is cheap and
--           idempotent); thread_id starts NULL and is backfilled once the
--           first message is actually sent — a thread needs a root message,
--           but "Chat" can be opened before anyone has written one.
--   CHANNEL channel_id is set immediately; conversation_id/thread_id stay
--           NULL. Channels have no thread concept (see 0003_threads_inbox.sql);
--           a channel task-discussion's messages are plain channel_messages
--           rows tagged by channel_messages.task_id (0036).
--
-- A task with multiple DM assignees gets one row per assignee (each has a
-- distinct conversation_id with the allocator); a task targeting several
-- channels gets one row per channel. No assignee_id column is needed for
-- either case — the conversation_id/channel_id already disambiguates.
--
-- No RLS policy, matching threads/thread_members (0003_threads_inbox.sql):
-- access is gated at the store layer (conversation/channel membership), not by
-- a Postgres policy on this table.
CREATE TABLE IF NOT EXISTS task_discussions (
    id              uuid PRIMARY KEY,            -- uuidv7, app-side
    org_id          uuid NOT NULL,
    task_id         uuid NOT NULL,                -- task-svc tasks.id — opaque, no FK
    kind            text NOT NULL CHECK (kind IN ('DM', 'CHANNEL')),
    conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
    thread_id       uuid REFERENCES threads(id) ON DELETE SET NULL,
    channel_id      uuid REFERENCES channels(id) ON DELETE CASCADE,
    created_by      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotent "open or create": a plain UNIQUE(task_id, conversation_id,
-- channel_id) would not dedupe two concurrent CHANNEL-kind opens, since
-- Postgres never treats two NULLs (their shared conversation_id) as equal —
-- hence two PARTIAL indexes, one per kind, each unique on the column that
-- kind actually populates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_discussions_dm
    ON task_discussions (task_id, conversation_id) WHERE kind = 'DM';
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_discussions_channel
    ON task_discussions (task_id, channel_id) WHERE kind = 'CHANNEL';

-- The bulk lookup the sticky widget / task list need: "every discussion row
-- for any of these task ids".
CREATE INDEX IF NOT EXISTS idx_task_discussions_task
    ON task_discussions (task_id);
