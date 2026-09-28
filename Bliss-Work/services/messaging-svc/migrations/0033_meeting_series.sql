-- 0033_meeting_series.sql — repeating meetings, and which channels a meeting
-- was addressed to.
--
-- This migration is IDEMPOTENT and ADDITIVE. Store.Migrate runs a file whenever
-- its checksum is not yet in the ledger (so an edited file runs again), and prod
-- runs old and new replicas side by side during a rollout. Every statement
-- therefore guards re-execution, and nothing here removes or renames what the
-- previous release reads. `calls` gains two columns whose defaults make every
-- existing row read exactly as before.
--
-- ── Why a series table AND a row per occurrence ──────────────────────────────
-- A meeting's whole lifecycle hangs off its `calls` row: the sweeper starts it at
-- scheduled_at and ends it at ends_at, participants join it, its recording, chat
-- and notes reference it. A repeating meeting therefore cannot be a single row
-- with a rule on it — each occurrence has to be a real call for any of that to
-- work.
--
-- What must NOT happen is writing every occurrence of a series that never ends.
-- So `call_series` holds the TEMPLATE (title, roster, rule, zone) and
-- `next_start_at`, the first occurrence not yet written. Occurrences are written
-- a rolling horizon ahead (store/meeting_series.go), by the create/edit request
-- itself and afterwards by the existing call sweeper. A weekly Mon/Wed/Fri
-- series is a handful of rows, not thousands.
--
-- This is the same split task-svc uses for recurring tasks (task_schedules), with
-- the same vocabulary, so the two features read alike to clients.
--
-- ── Time zone ────────────────────────────────────────────────────────────────
-- `time_zone` is an IANA name, and `first_start_at` is the anchor whose LOCAL
-- date and time of day every occurrence is computed from. Without the zone,
-- "every Monday at 10:00" would drift an hour either side of a daylight-saving
-- change; see internal/recurrence.
--
-- ── Who is on a repeating meeting ────────────────────────────────────────────
-- `invitee_ids` are the members the organiser picked; `channel_ids` are channels
-- whose CURRENT members are added at each occurrence (never copied here — a
-- member who leaves a channel stops being invited to later occurrences). The two
-- are kept apart on purpose: an edit form has to show what was picked, which is
-- not the same set as who ended up on the roster.

CREATE TABLE IF NOT EXISTS call_series (
    id                  uuid PRIMARY KEY,
    -- The HOSTING org; also the organiser's.
    org_id              uuid NOT NULL,
    created_by          uuid NOT NULL,
    title               text NOT NULL DEFAULT '',
    media               text NOT NULL DEFAULT 'video' CHECK (media IN ('audio', 'video')),
    time_zone           text NOT NULL,
    first_start_at      timestamptz NOT NULL,
    -- 0 is "no scheduled end", the same meaning as calls.ends_at being NULL.
    duration_minutes    integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 0 AND 720),
    frequency           text NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
    frequency_interval  integer NOT NULL DEFAULT 1 CHECK (frequency_interval BETWEEN 1 AND 99),
    -- 0 = Monday .. 6 = Sunday, as in task_schedules. WEEKLY only.
    weekdays            smallint[] NOT NULL DEFAULT '{}',
    end_condition       text NOT NULL DEFAULT 'NO_END'
                        CHECK (end_condition IN ('NO_END', 'ON_DATE', 'AFTER_OCCURRENCES')),
    -- A calendar date in time_zone: the last day an occurrence may start on.
    end_date            date,
    occurrence_limit    integer CHECK (occurrence_limit IS NULL OR occurrence_limit BETWEEN 1 AND 999),
    -- How many occurrences have been written so far (the AFTER_OCCURRENCES count).
    occurrence_count    integer NOT NULL DEFAULT 0,
    -- The first occurrence NOT yet written; NULL once the series is finished.
    next_start_at       timestamptz,
    invitee_ids         uuid[] NOT NULL DEFAULT '{}',
    channel_ids         uuid[] NOT NULL DEFAULT '{}',
    status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'CANCELLED', 'COMPLETED')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT call_series_weekdays_valid CHECK (
        weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
        AND (frequency = 'WEEKLY') = (cardinality(weekdays) > 0)
    ),
    CONSTRAINT call_series_end_shape CHECK (
        (end_condition = 'NO_END' AND end_date IS NULL AND occurrence_limit IS NULL)
        OR (end_condition = 'ON_DATE' AND end_date IS NOT NULL AND occurrence_limit IS NULL)
        OR (end_condition = 'AFTER_OCCURRENCES' AND end_date IS NULL AND occurrence_limit IS NOT NULL)
    )
);

-- The top-up sweep's only query: "which active series have occurrences still to
-- write inside the horizon?". Partial on exactly that predicate, so it stays the
-- size of the LIVE series rather than the size of the history.
CREATE INDEX IF NOT EXISTS idx_call_series_due
    ON call_series (next_start_at)
    WHERE status = 'ACTIVE' AND next_start_at IS NOT NULL;

-- ── calls ────────────────────────────────────────────────────────────────────
-- Which series an occurrence belongs to. No foreign key, matching every other
-- table in this schema; org purge deletes both explicitly.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS series_id uuid;

-- The channels this meeting was addressed to. Distinct from `channel_id`, which
-- is a CHANNEL call's own channel and is forbidden on a MEETING by
-- calls_channel_kind (0015). For a MEETING this is a record of who was asked
-- (and lets an edit form show it), not a roster — participants are.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS channel_ids uuid[] NOT NULL DEFAULT '{}';

-- Who the SERIES placed on an occurrence, as opposed to somebody added by hand
-- (AddParticipant) or who arrived by link. Editing a series re-derives its people
-- and must be able to remove exactly the ones it seated — never a guest, and never
-- a person another participant invited to that one meeting. NULL-safe default:
-- every existing row, and every one-off meeting, is "not placed by a series".
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS series_seated boolean NOT NULL DEFAULT false;

-- A series can never hold two occurrences at the same instant. This is the
-- backstop that makes writing an occurrence twice — two replicas' sweepers
-- racing, or a retried request — fail loudly instead of double-booking people.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_series_start
    ON calls (series_id, scheduled_at)
    WHERE series_id IS NOT NULL;

SELECT apply_org_isolation('call_series');
