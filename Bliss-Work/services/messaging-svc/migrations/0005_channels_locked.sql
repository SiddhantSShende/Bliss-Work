-- Channels gain a visibility flag: OPEN (anyone in the org can join) or
-- LOCKED (invite-only). Existing rows default to OPEN so the migration is a
-- no-op for older orgs that have only created channels through the legacy
-- "addChannelMembers" admit flow.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

-- Audit who left and when so re-joining an open channel can backfill from
-- the appropriate point (a future enhancement; the column is cheap now and
-- avoids a follow-up migration). For LOCKED channels, a left row is the
-- soft-delete signal that prevents auto re-add when /channels/open is
-- re-listed by the same user.
CREATE TABLE IF NOT EXISTS channel_member_history (
    channel_id uuid NOT NULL,
    org_id     uuid NOT NULL,
    user_id    uuid NOT NULL,
    left_at    timestamptz NOT NULL DEFAULT now(),
    reason     text NOT NULL DEFAULT 'left',  -- 'left' | 'kicked'
    PRIMARY KEY (channel_id, user_id, left_at)
);

CREATE INDEX IF NOT EXISTS idx_channel_member_history_user
    ON channel_member_history (user_id);
