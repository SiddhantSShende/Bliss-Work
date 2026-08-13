-- messaging-svc schema (idempotent).

CREATE TABLE IF NOT EXISTS conversations (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL,
    user_low    uuid NOT NULL,
    user_high   uuid NOT NULL,
    seq_counter bigint NOT NULL DEFAULT 0,
    last_msg_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, user_low, user_high)
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id uuid NOT NULL,
    org_id          uuid NOT NULL,
    user_id         uuid NOT NULL,
    visible         bool NOT NULL DEFAULT true,
    hidden_at_seq   bigint,
    last_read_seq   bigint NOT NULL DEFAULT 0,
    blocked         bool NOT NULL DEFAULT false,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id              uuid PRIMARY KEY,
    org_id          uuid NOT NULL,
    conversation_id uuid NOT NULL,
    seq             bigint NOT NULL,
    sender_id       uuid NOT NULL,
    body            text NOT NULL,
    client_msg_id   uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, seq),
    UNIQUE (conversation_id, sender_id, client_msg_id)
);

CREATE TABLE IF NOT EXISTS user_projection (
    user_id      uuid PRIMARY KEY,
    org_id       uuid NOT NULL,
    username     text NOT NULL,
    display_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
    id           uuid PRIMARY KEY,
    topic        text NOT NULL,
    kafka_key    text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS consumed_events (
    event_id    uuid PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_members_user
    ON conversation_members (user_id) WHERE visible = true;

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
    ON messages (conversation_id, seq);
