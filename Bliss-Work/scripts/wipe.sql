-- One-shot cleanup: keep only two hardcoded dev accounts and their org;
-- wipe every chat, channel, task, notification, conversation, inbox row,
-- outbox event, refresh token, audit log, and idempotency key in the
-- entire stack. THERE IS NO UNDO.
--
-- Do NOT run this file directly (docker exec ... < scripts/wipe.sql) — it
-- used to be copy-paste-executable with no idea what database it was about
-- to run against, unlike every other destructive script in this repo
-- (purge-orgs.sh, backup-db.sh, restore-db.sh), which hardcode their target
-- compose project explicitly and require deliberate opt-in. This one now
-- does too:
--
--   WIPE_CONFIRM=I-understand-this-deletes-data bash scripts/wipe-dev-db.sh
--
-- The kept org/user ids below are the maintainer's own personal dev-stack
-- accounts (not scripts/seed.ts's demo org — those are separate identities)
-- and are meaningless outside this one hardcoded dev database. The emails
-- that used to be here as identifying comments have been removed; the ids
-- are all the SQL below actually needs.

\connect authdb
BEGIN;
DELETE FROM refresh_tokens;
DELETE FROM invites;
DELETE FROM audit_log;
DELETE FROM outbox;
DELETE FROM user_roles WHERE user_id NOT IN (
    '019ed5d8-abeb-7329-8d31-cfc67dee3b52',
    '019ed705-bc7e-7c63-936b-2254b478ee17'
);
DELETE FROM users WHERE id NOT IN (
    '019ed5d8-abeb-7329-8d31-cfc67dee3b52',
    '019ed705-bc7e-7c63-936b-2254b478ee17'
);
DELETE FROM orgs WHERE id <> '019ed5d8-abe9-72c9-b02e-ef301069b9ce';
COMMIT;

\connect taskdb
BEGIN;
TRUNCATE TABLE task_assignees CASCADE;
TRUNCATE TABLE tasks CASCADE;
TRUNCATE TABLE outbox;
TRUNCATE TABLE consumed_events;
TRUNCATE TABLE idempotency_keys;
TRUNCATE TABLE canvas_nodes;
DELETE FROM user_projection WHERE user_id NOT IN (
    '019ed5d8-abeb-7329-8d31-cfc67dee3b52',
    '019ed705-bc7e-7c63-936b-2254b478ee17'
);
COMMIT;

\connect messagingdb
BEGIN;
TRUNCATE TABLE inbox_items CASCADE;
TRUNCATE TABLE channel_member_history;
TRUNCATE TABLE channel_messages CASCADE;
TRUNCATE TABLE channel_members CASCADE;
TRUNCATE TABLE channels CASCADE;
TRUNCATE TABLE messages CASCADE;
TRUNCATE TABLE threads CASCADE;
TRUNCATE TABLE conversation_members CASCADE;
TRUNCATE TABLE conversations CASCADE;
TRUNCATE TABLE outbox;
TRUNCATE TABLE consumed_events;
TRUNCATE TABLE consumed_events_inbox_tasks;
TRUNCATE TABLE idempotency_keys;
DELETE FROM user_projection WHERE user_id NOT IN (
    '019ed5d8-abeb-7329-8d31-cfc67dee3b52',
    '019ed705-bc7e-7c63-936b-2254b478ee17'
);
COMMIT;

\connect notificationdb
BEGIN;
TRUNCATE TABLE notifications;
TRUNCATE TABLE outbox;
TRUNCATE TABLE consumed_events;
COMMIT;
