-- task-svc schema (taskdb). Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS tasks (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL,
    sender_id   uuid NOT NULL,
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
    CREATE TYPE assignee_status AS ENUM ('SENT', 'IGNORED', 'ACKNOWLEDGED', 'COMPLETED', 'LEFT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS task_assignees (
    task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    org_id           uuid NOT NULL,
    assignee_id      uuid NOT NULL,
    status           assignee_status NOT NULL DEFAULT 'SENT',
    status_version   int NOT NULL DEFAULT 0,
    sender_dismissed boolean NOT NULL DEFAULT false,
    assigned_at      timestamptz NOT NULL DEFAULT now(),
    acknowledged_at  timestamptz,
    completed_at     timestamptz,
    ignored_at       timestamptz,
    left_at          timestamptz,
    PRIMARY KEY (task_id, assignee_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_assignee ON task_assignees (org_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_sender ON tasks (org_id, sender_id);

CREATE TABLE IF NOT EXISTS user_projection (
    user_id      uuid PRIMARY KEY,
    org_id       uuid NOT NULL,
    username     text NOT NULL,
    display_name text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS outbox (
    id           uuid PRIMARY KEY,
    topic        text NOT NULL,
    kafka_key    text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS consumed_events (
    event_id    uuid PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for POST /tasks (Idempotency-Key header).
CREATE TABLE IF NOT EXISTS idempotency_keys (
    org_id     uuid NOT NULL,
    key        text NOT NULL,
    task_id    uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, key)
);
