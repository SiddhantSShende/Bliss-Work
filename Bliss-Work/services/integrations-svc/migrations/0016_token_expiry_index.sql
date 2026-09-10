-- refresh_worker's due-batch sweep (app/refresh_worker.py, every 60s) filters
-- status='connected' AND refresh_token_enc IS NOT NULL AND token_expires_at
-- IS NOT NULL AND token_expires_at < <window>, ordered by token_expires_at.
-- No index covered this — every sweep was a full scan of
-- integration_connections, platform-wide, growing with total connected
-- accounts across every org. Same shape as the sibling next_ingest_at /
-- push_expires_at partial indexes added in 0006_push_ingest.sql, which this
-- one was simply missed alongside.
--
-- slack/whatsapp connections never set token_expires_at (grep-confirmed: only
-- the OAuth callback and the OAuth-token-refresh internal routes write it),
-- so the partial predicate alone already scopes this to gmail/outlook/teams
-- without needing a provider filter, matching idx_integration_conn_push_expiry's
-- own convention of leaving the caller's other filters implicit.
CREATE INDEX IF NOT EXISTS idx_integration_conn_token_expiry
    ON integration_connections (token_expires_at)
    WHERE status = 'connected'
      AND refresh_token_enc IS NOT NULL
      AND token_expires_at IS NOT NULL;
