-- notification-svc schema (notificationdb). Idempotent; executed on startup.

CREATE TABLE IF NOT EXISTS notifications (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL,
    recipient_id uuid NOT NULL,
    kind        text NOT NULL,
    text        text NOT NULL,
    task_id     uuid NULL,
    read_at     timestamptz NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
    ON notifications (recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
    id           uuid PRIMARY KEY,
    topic        text NOT NULL,
    kafka_key    text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON outbox (created_at)
    WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS consumed_events (
    event_id    uuid PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);
