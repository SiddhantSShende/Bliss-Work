-- Deferred task allocation templates and their materialized task occurrences.
CREATE TABLE IF NOT EXISTS task_schedules (
    id                  uuid PRIMARY KEY,
    org_id              uuid NOT NULL,
    sender_id           uuid NOT NULL,
    title_enc           bytea NOT NULL,
    description_enc     bytea NOT NULL,
    channel_id          uuid,
    assignee_ids        uuid[] NOT NULL DEFAULT '{}',
    kind                text NOT NULL CHECK (kind IN ('SCHEDULED', 'RECURRING')),
    scheduled_for       timestamptz,
    start_at            timestamptz NOT NULL,
    frequency           text,
    frequency_interval  integer,
    weekdays            smallint[] NOT NULL DEFAULT '{}',
    monthly_rule        text,
    monthly_day         smallint,
    monthly_ordinal     smallint,
    monthly_weekday     smallint,
    end_condition       text NOT NULL DEFAULT 'NO_END',
    end_at              timestamptz,
    occurrence_limit    integer,
    occurrence_count    integer NOT NULL DEFAULT 0,
    next_run_at         timestamptz NOT NULL,
    status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED', 'COMPLETED')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'SCHEDULED' AND scheduled_for IS NOT NULL AND frequency IS NULL)
        OR (kind = 'RECURRING' AND scheduled_for IS NULL AND frequency IS NOT NULL)),
    CHECK (channel_id IS NOT NULL OR cardinality(assignee_ids) > 0)
);

CREATE INDEX IF NOT EXISTS idx_task_schedules_due
    ON task_schedules (next_run_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_task_schedules_sender
    ON task_schedules (org_id, sender_id, status);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES task_schedules(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS occurrence_number integer;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_schedule_occurrence
    ON tasks (schedule_id, occurrence_number)
    WHERE schedule_id IS NOT NULL;

SELECT apply_org_isolation('task_schedules');