-- 018_project_channels — a project can group more than its own auto-created
-- channel. Until now `projects.channel_id` was the project's ONE channel,
-- created automatically and never a pre-existing one. This table lets a
-- project additionally link existing channels (each with >=2 real members,
-- enforced in application code at link time, not here) without touching
-- `projects.channel_id`, which stays the project's original/primary channel
-- for backward compatibility with every existing reader (ProjectDTO.channelId,
-- analytics, the locked-channel row in AssignToPanel).
--
-- Purely additive: existing projects get exactly one backfilled row (their
-- own channel_id) and keep working unchanged.

CREATE TABLE IF NOT EXISTS project_channels (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id     uuid NOT NULL,
    channel_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_project_channels_channel ON project_channels (org_id, channel_id);

INSERT INTO project_channels (project_id, org_id, channel_id)
SELECT id, org_id, channel_id FROM projects WHERE channel_id IS NOT NULL
ON CONFLICT DO NOTHING;

SELECT apply_org_isolation('project_channels');
