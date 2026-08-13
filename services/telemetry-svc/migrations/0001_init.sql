-- telemetry-svc schema (telemetrydb). Idempotent; executed on every startup.
--
-- This database holds the member activity record: what people did, when they
-- were online, which sections and apps and sites they used. It stores NO names
-- and NO email addresses — only user ids, joined against auth-svc's directory by
-- the client. A compromise here yields behaviour without identity.
--
-- Retention is 90 days of raw events with daily rollups kept forever, which is
-- why activity_events is PARTITIONED BY RANGE on the day. See the note above
-- ensure_activity_partitions().

-- ── org_keys ─ per-org wrapped DEKs for the Cryptor ──────────────────────────
-- IDENTICAL shape to auth-svc / task-svc / messaging-svc / integrations-svc so
-- the shared key-rotation tooling works uniformly across every service.
--
-- Created HERE, in 0001, and NOT in a later migration: 0002_rls.sql applies a
-- policy to this table, and migrations run in lexical order. Splitting the two
-- across 0001/0003 is exactly the coupling that has bitten this repo before —
-- the RLS file would reference a table that does not exist yet and the whole
-- startup migration pass would fail.
CREATE TABLE IF NOT EXISTS org_keys (
    org_id      uuid        NOT NULL,
    key_version smallint    NOT NULL,
    wrapped_dek bytea       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,
    PRIMARY KEY (org_id, key_version)
);
CREATE INDEX IF NOT EXISTS idx_org_keys_current
    ON org_keys (org_id) WHERE retired_at IS NULL;

-- ── Raw activity stream ──────────────────────────────────────────────────────
-- Append-only. Every row is either server-observed (derived from a Kafka domain
-- event — unforgeable) or client-reported (a beacon from the web/desktop app, or
-- an agent). `source` is what tells them apart, and the UI renders the
-- difference, because one is evidence and the other is a claim.
CREATE TABLE IF NOT EXISTS activity_events (
    id           uuid        NOT NULL,   -- uuid7 (time-ordered)
    org_id       uuid        NOT NULL,
    user_id      uuid        NOT NULL,
    session_id   uuid,                   -- soft link to user_sessions.id
    occurred_at  timestamptz NOT NULL,   -- clamped client clock, or server time
    received_at  timestamptz NOT NULL DEFAULT now(),
    source       text        NOT NULL,   -- 'server'|'web'|'desktop'|'extension'
    category     text        NOT NULL,   -- 'auth'|'navigation'|'engagement'|'app'|'site'
    action       text        NOT NULL,   -- 'login'|'route.enter'|'task.completed'|…
    surface      text,                   -- 'tasks'|'chats'|'channels'|'inbox'|…
    target_kind  text,                   -- 'task'|'channel'|'conversation'|'app'|'site'
    target_id    text,                   -- uuid / app_key / registrable domain
    duration_ms  integer,                -- span rows (route dwell, app foreground)
    detail_enc   bytea,                  -- AES-256-GCM under the org DEK
    -- The partition key MUST be part of every unique constraint, hence the
    -- composite PK. id alone is still globally unique (uuid7).
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- `target_id` is deliberately PLAINTEXT: it is what every aggregate groups by
-- ("which sites, which apps, which channels"), and it is coarse — an id, an
-- executable name, or a registrable domain. The revealing half (a full URL path,
-- a message preview) lives in `detail_enc`, encrypted per-org, readable only
-- one row at a time on the timeline.

CREATE INDEX IF NOT EXISTS idx_activity_user_time
    ON activity_events (org_id, user_id, occurred_at DESC, id DESC);  -- the timeline
CREATE INDEX IF NOT EXISTS idx_activity_org_time
    ON activity_events (org_id, occurred_at DESC);                    -- org rollups/export
CREATE INDEX IF NOT EXISTS idx_activity_session
    ON activity_events (session_id) WHERE session_id IS NOT NULL;

-- DAILY partitions, not monthly.
--
-- The retention rule is exactly 90 days. Monthly partitions would hold up to
-- 120; weekly, up to 97. Daily gives exact compliance AND turns the prune into
-- an O(1) DROP TABLE instead of a multi-million-row DELETE that would bloat a
-- Postgres shared with every other service on this host.
--
-- There is deliberately NO DEFAULT partition: a DEFAULT partition with rows in
-- it blocks attaching any new partition whose range overlaps, which would break
-- the nightly job in a way that is tedious to unpick. Instead the ingest layer
-- catches "no partition of relation" and retries once after calling this.
CREATE OR REPLACE FUNCTION ensure_activity_partitions(days_ahead int DEFAULT 30)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    d    date;
    name text;
BEGIN
    -- One day back as well as forward: a client with a slow clock (or a batch
    -- flushed just after midnight) still lands somewhere real.
    FOR d IN SELECT generate_series(
        (now() AT TIME ZONE 'UTC')::date - 1,
        (now() AT TIME ZONE 'UTC')::date + days_ahead,
        interval '1 day'
    )::date LOOP
        name := 'activity_events_' || to_char(d, 'YYYYMMDD');
        IF to_regclass('public.' || name) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF activity_events FOR VALUES FROM (%L) TO (%L)',
                name, d, d + 1);
            -- RLS is enforced per-partition as well as on the parent. Access
            -- through the parent is already covered, but a policy on the leaf
            -- means a direct query against the partition (a maintenance script,
            -- a mistaken join) is equally fenced.
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
            EXECUTE format(
                'CREATE POLICY org_isolation ON %I USING ('
                '  current_setting(''app.bypass_rls'', true) = ''on'''
                '  OR org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid'
                ') WITH CHECK ('
                '  current_setting(''app.bypass_rls'', true) = ''on'''
                '  OR org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid'
                ')', name);
        END IF;
    END LOOP;
END $$;

SELECT ensure_activity_partitions(30);

-- ── Sessions ─────────────────────────────────────────────────────────────────
-- A session is one client instance (shared across that browser's tabs), not one
-- socket and not one refresh-token family. `ended_at` is set by an explicit
-- logout/pagehide, or by the sweeper — which backdates it to last_seen_at rather
-- than to the moment it noticed, because the truthful answer to "when did they
-- go offline" is the last time we heard from them.
CREATE TABLE IF NOT EXISTS user_sessions (
    id             uuid PRIMARY KEY,
    org_id         uuid NOT NULL,
    user_id        uuid NOT NULL,
    source         text NOT NULL,                -- 'web'|'desktop'
    device_label   text NOT NULL DEFAULT '',     -- 'Chrome 141 · Windows' (derived, low-entropy)
    started_at     timestamptz NOT NULL,
    last_seen_at   timestamptz NOT NULL,
    ended_at       timestamptz,
    end_reason     text,                         -- 'logout'|'timeout'|'disconnect'|'revoked'|'org_switch'
    active_ms      bigint NOT NULL DEFAULT 0,
    idle_ms        bigint NOT NULL DEFAULT 0,
    ip_prefix      text,                         -- v4 /24, v6 /48 — coarse, plaintext
    ip_enc         bytea,                        -- full IP, encrypted
    user_agent_enc bytea,                        -- raw UA, encrypted
    created_at     timestamptz NOT NULL DEFAULT now()
);
-- The full IP and UA are personal data and live encrypted; the /24 prefix and a
-- derived "Chrome 141 · Windows" label are not identifying on their own and are
-- what the UI actually renders, so the common path never decrypts anything.
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions (org_id, user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_open ON user_sessions (org_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_seen ON user_sessions (org_id, last_seen_at DESC);
-- The sweeper scans every org's open sessions at once, so it needs an index that
-- is NOT org-scoped.
CREATE INDEX IF NOT EXISTS idx_sessions_sweep ON user_sessions (last_seen_at) WHERE ended_at IS NULL;

-- ── Rollups: NEVER pruned ────────────────────────────────────────────────────
-- These are what make a year-over-year chart possible after the raw events for
-- that period are long gone. The prune job refuses to drop a day that has no
-- row here, so the two can never get out of order.
CREATE TABLE IF NOT EXISTS activity_daily (
    org_id         uuid NOT NULL,
    user_id        uuid NOT NULL,
    day            date NOT NULL,
    first_seen_at  timestamptz,
    last_seen_at   timestamptz,
    sessions_count integer NOT NULL DEFAULT 0,
    active_ms      bigint NOT NULL DEFAULT 0,
    idle_ms        bigint NOT NULL DEFAULT 0,
    online_ms      bigint NOT NULL DEFAULT 0,
    events_count   integer NOT NULL DEFAULT 0,
    by_surface     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"tasks": 420000}  (ms)
    by_action      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"task.completed": 7}
    by_hour        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"0".."23": ms}  → heatmap
    computed_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_org_day ON activity_daily (org_id, day);

CREATE TABLE IF NOT EXISTS app_usage_daily (
    org_id        uuid NOT NULL,
    user_id       uuid NOT NULL,
    day           date NOT NULL,
    app_key       text NOT NULL,   -- normalized bundle id / executable basename
    app_name      text NOT NULL,   -- display name — NEVER the window title
    foreground_ms bigint NOT NULL DEFAULT 0,
    switches      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, user_id, day, app_key)
);

CREATE TABLE IF NOT EXISTS site_usage_daily (
    org_id   uuid NOT NULL,
    user_id  uuid NOT NULL,
    day      date NOT NULL,
    domain   text NOT NULL,        -- registrable domain only ('github.com')
    visit_ms bigint NOT NULL DEFAULT 0,
    visits   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, user_id, day, domain)
);

-- ── Agent credentials (desktop sampler + browser extension) ──────────────────
-- Neither agent can do the SameSite-cookie refresh dance, and an extension has
-- no secure storage, so neither ever receives a JWT or a refresh token. They get
-- a single-purpose secret, hashed here, scoped to exactly one (org, user), and
-- revoked automatically when that membership ends.
CREATE TABLE IF NOT EXISTS ingest_tokens (
    id           uuid PRIMARY KEY,
    org_id       uuid NOT NULL,
    user_id      uuid NOT NULL,
    kind         text NOT NULL,               -- 'extension'|'desktop'
    token_hash   bytea UNIQUE NOT NULL,       -- sha256(raw); raw is shown once
    label        text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_tokens_user ON ingest_tokens (org_id, user_id);

-- ── Kafka consumer dedup ─────────────────────────────────────────────────────
-- No org_id, therefore no RLS — same exemption as auth-svc's outbox and
-- refresh_tokens. Pruned to 7 days by the nightly job.
CREATE TABLE IF NOT EXISTS consumed_events (
    event_id    uuid PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consumed_at ON consumed_events (consumed_at);
