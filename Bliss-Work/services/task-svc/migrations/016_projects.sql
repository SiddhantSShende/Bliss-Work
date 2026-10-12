CREATE TABLE IF NOT EXISTS projects (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    name_enc   bytea NOT NULL,
    name_hash  bytea NOT NULL,
    channel_id uuid NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_name_hash ON projects (org_id, name_hash);
CREATE INDEX IF NOT EXISTS idx_projects_org_channel ON projects (org_id, channel_id);
SELECT apply_org_isolation('projects');

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id uuid NULL REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (org_id, project_id);

ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS project_id uuid NULL REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS idx_task_schedules_project ON task_schedules (org_id, project_id);
