-- group channels schema (idempotent).

CREATE TABLE IF NOT EXISTS channels (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL,
    name        text NOT NULL,
    seq_counter bigint NOT NULL DEFAULT 0,
    created_by  uuid NOT NULL,
    last_msg_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id uuid NOT NULL,
    org_id     uuid NOT NULL,
    user_id    uuid NOT NULL,
    joined_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL,
    channel_id    uuid NOT NULL,
    seq           bigint NOT NULL,
    sender_id     uuid NOT NULL,
    body          text NOT NULL,
    client_msg_id uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel_id, seq),
    UNIQUE (channel_id, sender_id, client_msg_id)
);

CREATE INDEX IF NOT EXISTS idx_channels_org
    ON channels (org_id);

CREATE INDEX IF NOT EXISTS idx_channel_members_user
    ON channel_members (user_id);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_seq
    ON channel_messages (channel_id, seq);
