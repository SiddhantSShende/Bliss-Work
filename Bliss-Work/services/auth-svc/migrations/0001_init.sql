-- auth-svc schema (authdb). Idempotent; executed on startup.
-- citext extension is created by infra/postgres/init; ensure it anyway.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS orgs (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    slug        citext UNIQUE NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid
);

CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL,
    email         citext NOT NULL,
    username      citext NOT NULL,
    password_hash text NOT NULL,
    display_name  text NOT NULL,
    status        text NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, email),
    UNIQUE (org_id, username)
);

CREATE TABLE IF NOT EXISTS roles (
    id   serial PRIMARY KEY,
    name text UNIQUE NOT NULL
);

INSERT INTO roles (name) VALUES ('org_admin')
    ON CONFLICT (name) DO NOTHING;
INSERT INTO roles (name) VALUES ('member')
    ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_roles (
    user_id uuid NOT NULL,
    role_id int  NOT NULL,
    org_id  uuid NOT NULL,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL,
    token_hash bytea UNIQUE NOT NULL,
    family_id  uuid NOT NULL,
    rotated_to uuid,
    revoked    boolean NOT NULL DEFAULT false,
    issued_at  timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE IF NOT EXISTS invites (
    id               uuid PRIMARY KEY,
    org_id           uuid NOT NULL,
    email            citext NOT NULL,
    role_id          int  NOT NULL,
    token_hash       bytea UNIQUE NOT NULL,
    status           text NOT NULL DEFAULT 'pending',
    invited_by       uuid,
    expires_at       timestamptz NOT NULL,
    accepted_at      timestamptz,
    accepted_user_id uuid,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites (org_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id        bigserial PRIMARY KEY,
    org_id    uuid NOT NULL,
    actor_id  uuid,
    action    text NOT NULL,
    target    text,
    meta      jsonb,
    at        timestamptz NOT NULL DEFAULT now()
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
