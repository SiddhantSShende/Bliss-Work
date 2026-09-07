-- 0004: scope RelayConsumer's reaper to its OWN rows.
--
-- email_consumed is shared by two independent consumers: RelayConsumer
-- (messaging/task notification relay) and EmailWorker (invite / password-
-- reset / email-verification). RelayConsumer's reaper (_reap_once) sweeps
-- every row still 'pending' past a 30s abandonment window and flips it to
-- 'sent' WITHOUT actually sending anything — an accepted tradeoff for
-- RelayConsumer's own notifications, whose in-app inbox is always the
-- authoritative record regardless of whether the relay email went out too.
--
-- That tradeoff does not hold for EmailWorker's rows: an invite / password-
-- reset / email-verification link has no in-app fallback. If the reaper ever
-- swept one of those, a crash-orphaned claim would be silently marked "sent"
-- and the user would simply never receive the email, with no error anywhere.
-- `owner` lets the reaper (and any future sweep) tell the two apart and only
-- ever touch its own.
ALTER TABLE email_consumed
    ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'relay'
        CHECK (owner IN ('relay', 'email_worker'));
