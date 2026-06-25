-- Tasks gain an OPTIONAL channel_id linking them back to the channel they
-- were allocated to. Existing tasks (assigned to specific people) carry
-- NULL — they behave exactly as before.
--
-- When channel_id is set, two things happen:
--   1. At creation time, task-svc resolves the channel's current members
--      via messaging-svc's internal endpoint and writes a task_assignees
--      row for each. The "Acknowledge / Ignore" sticky-note flow fires for
--      every member exactly as for a personally-allocated task.
--   2. Retroactively: when a user joins a channel later, the ChannelMember
--      Joined event from messaging-svc drives an INSERT into task_assignees
--      for every active task tied to that channel — the new member catches
--      up to whatever commitments the channel already holds.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel_id uuid;

-- The retroactive lookup is "find every task allocated to channel X that's
-- still actionable". Index on channel_id makes it cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks (org_id, channel_id)
    WHERE channel_id IS NOT NULL;
