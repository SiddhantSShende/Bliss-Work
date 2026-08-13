-- Blocking someone from a channel.
--
-- A SEPARATE TABLE, not a `blocked` column on channel_members, and the reason is
-- structural: leaving a channel DELETEs the member row, and so does a kick. A
-- flag on that row would evaporate at exactly the moment it is needed — kick a
-- disruptive member from an open channel and they would simply re-join. (The DM
-- analogue gets away with a column only because `conversation_members` rows are
-- never deleted.)
--
-- The block therefore outlives membership, which is what makes it a block rather
-- than a removal.

CREATE TABLE IF NOT EXISTS channel_blocks (
    channel_id uuid        NOT NULL,
    org_id     uuid        NOT NULL,
    user_id    uuid        NOT NULL,
    blocked_by uuid        NOT NULL,
    reason     text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

-- "Which channels am I blocked from" — read on every open-channel listing so a
-- join button is never offered for a channel that would 403.
CREATE INDEX IF NOT EXISTS idx_channel_blocks_user ON channel_blocks (org_id, user_id);

-- RLS inline, NOT in 0007_rls.sql: that migration enumerates a fixed list of
-- tables and has already run in production, so it will never cover a table added
-- afterwards. Every new org-bearing table has to bring its own policy.
ALTER TABLE channel_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_blocks FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'channel_blocks'
    ) THEN
        CREATE POLICY org_isolation ON channel_blocks
            USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')
            WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on');
    END IF;
END $$;
