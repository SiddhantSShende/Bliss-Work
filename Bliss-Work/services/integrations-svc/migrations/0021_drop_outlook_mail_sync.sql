-- 0021_drop_outlook_mail_sync.sql — remove tables exclusive to the removed
-- Outlook mail integration (mail-sync delta walk, write-back, and the
-- /internal/mail/send idempotency claim). Nothing else writes or reads these:
--
--   mail_sync_links      — Graph message id <-> messaging-svc mail mapping,
--                          written only by the now-deleted mail_sync_worker.py
--                          and mail_write_back_consumer.py (0019_mail_sync_links.sql).
--   mail_send_attempts   — idempotency claim for the now-deleted
--                          POST /internal/mail/send route (0013_mail_send_idempotency.sql).
--
-- Both are specific to Microsoft Graph mail (Outlook); Gmail/Slack/Teams never
-- used them. Forward migration rather than editing 0013/0019 directly, since
-- those may already be applied in production.
-- ACKNOWLEDGE-BREAKING: both tables' only writers (mail_sync_worker.py,
-- mail_write_back_consumer.py, and the /internal/mail/send route) are removed
-- in this SAME release, so no code — old replica or new — writes to either
-- table by the time this migration is deployed. Ship the code and migration
-- together, as with every other migration in this file's history.
DROP TABLE IF EXISTS mail_sync_links;
DROP TABLE IF EXISTS mail_send_attempts;
