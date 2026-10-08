ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS browser_session_hash text;

ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS refresh_failure_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refresh_next_attempt_at timestamptz;
