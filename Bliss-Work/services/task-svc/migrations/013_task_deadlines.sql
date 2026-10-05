-- 013_task_deadlines — an optional deadline on a task, and the MISSED outcome
-- for an assignment whose deadline passed before it was completed.
--
-- Purely additive: every column is nullable and every existing row keeps its
-- meaning, so a task or schedule written before this migration (no deadline)
-- behaves exactly as it always did, and rolling the service back leaves the new
-- columns unread.
--
--   tasks.deadline_at         the CONCRETE deadline of this task. For a recurring
--                             schedule every occurrence is its own task row, so
--                             each carries the deadline resolved for THAT
--                             occurrence — never one timestamp for the series.
--   tasks.deadline_swept_at   set once the deadline sweeper has dealt with the
--                             task (see app/deadlines.py). It is what keeps the
--                             sweeper's work proportional to the tasks still
--                             waiting on a deadline rather than to every task
--                             that ever had one.
--   task_assignees.missed_at  when the assignment became MISSED. Missing is a
--                             per-assignee outcome, like completing or leaving.
--
--   task_schedules            the TEMPLATE carries the rule, because a schedule
--                             has no concrete date to resolve it against yet:
--                               SCHEDULED  deadline_at          an absolute instant
--                               RECURRING  deadline_kind        RELATIVE | FIXED_TIME
--                                          deadline_amount/unit RELATIVE: "N minutes|hours|days after"
--                                          deadline_time        FIXED_TIME: wall-clock time of day
--                                          deadline_tz          IANA zone the rule is read in
--                             The worker resolves the rule into tasks.deadline_at
--                             when it materializes each occurrence.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction on PG >= 12, but the new
-- value cannot be USED until that transaction commits. Nothing in this file (or any
-- earlier one) references 'MISSED' — the index below is on the existing statuses —
-- so the single boot-time migration transaction is safe.

ALTER TYPE assignee_status ADD VALUE IF NOT EXISTS 'MISSED';

ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS missed_at timestamptz;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_swept_at timestamptz;

-- The sweeper's only access path: tasks whose deadline is set and not yet swept,
-- oldest first. Partial, so a task with no deadline (nearly all of them) and a
-- task already swept cost nothing.
CREATE INDEX IF NOT EXISTS idx_tasks_deadline_pending
    ON tasks (deadline_at)
    WHERE deadline_at IS NOT NULL AND deadline_swept_at IS NULL;

ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS deadline_at     timestamptz;
ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS deadline_kind   text;
ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS deadline_amount integer;
ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS deadline_unit   text;
ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS deadline_time   time;
ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS deadline_tz     text;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'task_schedules'::regclass AND conname = 'task_schedules_deadline_rule'
    ) THEN
        ALTER TABLE task_schedules ADD CONSTRAINT task_schedules_deadline_rule CHECK (
            -- no rule: every rule column is empty
            (deadline_kind IS NULL
                AND deadline_amount IS NULL AND deadline_unit IS NULL
                AND deadline_time IS NULL AND deadline_tz IS NULL)
            -- relative: "amount unit after each occurrence"
            OR (deadline_kind = 'RELATIVE'
                AND deadline_amount > 0
                AND deadline_unit IN ('MINUTES', 'HOURS', 'DAYS')
                AND deadline_time IS NULL AND deadline_tz IS NOT NULL)
            -- fixed time: that time of day on the occurrence's own date
            OR (deadline_kind = 'FIXED_TIME'
                AND deadline_time IS NOT NULL
                AND deadline_amount IS NULL AND deadline_unit IS NULL
                AND deadline_tz IS NOT NULL)
        );
    END IF;

    -- A rule belongs to a recurring series, an absolute instant to a one-off.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'task_schedules'::regclass AND conname = 'task_schedules_deadline_kind_match'
    ) THEN
        ALTER TABLE task_schedules ADD CONSTRAINT task_schedules_deadline_kind_match CHECK (
            (deadline_kind IS NULL OR kind = 'RECURRING')
            AND (deadline_at IS NULL OR kind = 'SCHEDULED')
        );
    END IF;
END $$;
