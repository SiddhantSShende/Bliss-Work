-- One-shot cleanup: keep only the two AEIV users and the AEIV org;
-- wipe every chat, channel, task, notification, conversation, inbox row,
-- outbox event, refresh token, audit log, and idempotency key in the
-- entire stack. Run via:
--   docker exec -i task-board-postgres-1 psql -U taskboard < scripts/wipe.sql
--
-- AEIV org    : 019ed5d8-abe9-72c9-b02e-ef301069b9ce
-- siddhantsshende@gmail.com  : 019ed5d8-abeb-7329-8d31-cfc67dee3b52
-- siddhant.shende.btech2023@sitnagpur.siu.edu.in : 019ed705-bc7e-7c63-936b-2254b478ee17

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
