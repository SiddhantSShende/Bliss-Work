-- 0003_connection_created_by.sql — who connected an account (idempotent).
--
-- `owner_user_id` scopes VISIBILITY (NULL = org-wide, e.g. a Slack/WhatsApp bot);
-- `created_by` is always the user who ran the connect flow. It is the recipient of
-- the live `integration.activity.created` push, so org-wide connections still
-- deliver activity to a real user in real time.
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS created_by uuid;
