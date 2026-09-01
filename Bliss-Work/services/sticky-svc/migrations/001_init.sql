-- sticky-svc: durable, per-assignee record of "this task has a note on your
-- desktop, and it is still outstanding".
--
-- ── Why this table exists ────────────────────────────────────────────────────
-- Until now the pinned set lived ONLY on the client: a JSON file in the desktop
-- app's userData, and a localStorage key in the browser. Three consequences,
-- all of them things users reported as the feature "not working":
--
--   * A reinstall, a new machine or a cleared profile lost every pin.
--   * The desktop and the web app disagreed, because neither could see the
--     other's set.
--   * Nothing server-side knew whether an allocation had ever actually reached
--     the person it was allocated to.
--
-- The rule this table enforces is the product rule: a pin opens when a task is
-- assigned and closes ONLY when that task reaches a terminal status. Hiding a
-- note is a client-side, this-session decision and is deliberately not
-- represented here — there is no "dismissed" column, and there must never be
-- one. A persisted dismissal is exactly what broke this feature before.
--
-- ── What is NOT here ─────────────────────────────────────────────────────────
-- Task titles and descriptions. They are encrypted at rest in task-svc under a
-- per-org DEK; a second copy here would double the key-rotation and compliance
-- surface. Clients join these ids against GET /api/v1/tasks/sticky for content.

CREATE TABLE IF NOT EXISTS sticky_pins (
    org_id            uuid        NOT NULL,
    assignee_id       uuid        NOT NULL,
    task_id           uuid        NOT NULL,
    sender_id         uuid,
    -- OPEN | CLOSED. Only a terminal task status moves a pin to CLOSED.
    status            text        NOT NULL DEFAULT 'OPEN',
    -- COMPLETED | IGNORED | LEFT — why it closed, for the audit trail and for
    -- telling "they finished it" apart from "they refused it".
    close_reason      text,
    -- The assignee's task status as last seen (SENT | ACKNOWLEDGED). Mirrors
    -- task-svc so a client can render the note's buttons without a second call.
    assignee_status   text        NOT NULL DEFAULT 'SENT',
    -- task-svc's monotonic per-assignee counter. Guards every UPDATE below so a
    -- Kafka redelivery or an out-of-order partition read cannot reopen a pin
    -- that has already closed.
    status_version    int         NOT NULL DEFAULT 0,
    opened_at         timestamptz NOT NULL DEFAULT now(),
    closed_at         timestamptz,
    last_event_at     timestamptz NOT NULL DEFAULT now(),
    -- Set when a client confirms the note is actually on the user's screen.
    -- NULL on an open pin is the signal sticky-relay watches for.
    last_delivered_at timestamptz,
    delivery_attempts int         NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, assignee_id, task_id)
);

-- The read path: "which notes should be on this person's desktop right now".
CREATE INDEX IF NOT EXISTS idx_sticky_pins_open
    ON sticky_pins (org_id, assignee_id)
    WHERE status = 'OPEN';

-- The watchdog path: open pins nobody has confirmed receiving. Partial so it
-- stays small — the steady state is that almost every pin has been delivered.
CREATE INDEX IF NOT EXISTS idx_sticky_pins_undelivered
    ON sticky_pins (opened_at)
    WHERE status = 'OPEN' AND last_delivered_at IS NULL;

-- Kafka is at-least-once, so the consumer must be idempotent. Same approach as
-- task-svc: remember the event ids already applied and skip a repeat.
CREATE TABLE IF NOT EXISTS consumed_events (
    event_id    uuid        PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumed_events_consumed_at
    ON consumed_events (consumed_at);
