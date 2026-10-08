-- Deduplicate client-reported events independently of occurred_at. Client
-- timestamps can be absent or clamped differently on a retry, while the
-- stable client_event_id is generated once and retained by the client queue.
CREATE TABLE IF NOT EXISTS client_event_claims (
    org_id          uuid NOT NULL,
    user_id         uuid NOT NULL,
    client_event_id text NOT NULL,
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_client_event_claims_claimed_at
    ON client_event_claims (claimed_at);

SELECT apply_org_isolation('client_event_claims');

-- Preserve deduplication for events already retained in the partitioned table.
DO $$
DECLARE
    previous_bypass text;
BEGIN
    previous_bypass := current_setting('app.bypass_rls', true);
    PERFORM set_config('app.bypass_rls', 'on', true);

    INSERT INTO client_event_claims (org_id, user_id, client_event_id, claimed_at)
    SELECT DISTINCT ON (org_id, user_id, client_event_id)
           org_id, user_id, client_event_id, occurred_at
      FROM activity_events
     WHERE client_event_id IS NOT NULL
     ORDER BY org_id, user_id, client_event_id, occurred_at DESC
    ON CONFLICT DO NOTHING;

    PERFORM set_config('app.bypass_rls', COALESCE(previous_bypass, ''), true);
END $$;
