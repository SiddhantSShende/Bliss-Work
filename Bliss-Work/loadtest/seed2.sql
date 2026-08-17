-- Second seeding pass: DMs, the inbox, and notifications.
--
-- seed.sql made the channel list realistic, but conversations, inbox_items and
-- notifications were still empty — and between them those are ~60% of the load
-- profile. Measuring a mix where most requests read empty tables is barely
-- better than measuring an empty database, so this fills the rest.
--
-- Same ciphertext-reuse approach as seed.sql: DM bodies clone a real per-org
-- `body_enc`, so the decrypt on the read path does genuine work.
--
--   docker exec -i task-board-postgres-1 psql -U taskboard -d messagingdb -f -

\set ON_ERROR_STOP on
\timing on

BEGIN;

CREATE TEMP TABLE org_ref ON COMMIT DROP AS
SELECT org_id,
       (array_agg(body_enc ORDER BY created_at))[1] AS body_enc,
       (array_agg(sender_id ORDER BY created_at))[1] AS admin_id
FROM channel_messages
WHERE body_enc IS NOT NULL
GROUP BY org_id;

-- 40 DM peers per org, taken from the users seed.sql created.
CREATE TEMP TABLE peers ON COMMIT DROP AS
SELECT o.org_id, o.admin_id, u.user_id AS peer_id,
       row_number() OVER (PARTITION BY o.org_id ORDER BY u.user_id) AS idx
FROM org_ref o
JOIN LATERAL (
    SELECT up.user_id FROM user_projection up
    WHERE up.org_id = o.org_id AND up.user_id <> o.admin_id
    LIMIT 40
) u ON true;

-- conversations stores the pair order-normalised (user_low/user_high), which is
-- what makes "the DM between A and B" a single row rather than two.
-- Pairs that already have a conversation are skipped: (org_id, user_low,
-- user_high) is unique, which is the constraint that makes "the DM between A
-- and B" one row, and the dev database already holds a few.
CREATE TEMP TABLE new_convos ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, p.org_id,
       LEAST(p.admin_id, p.peer_id) AS user_low,
       GREATEST(p.admin_id, p.peer_id) AS user_high,
       p.admin_id, p.peer_id, p.idx
FROM peers p
WHERE NOT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.org_id = p.org_id
      AND c.user_low = LEAST(p.admin_id, p.peer_id)
      AND c.user_high = GREATEST(p.admin_id, p.peer_id)
);

INSERT INTO conversations (id, org_id, user_low, user_high, seq_counter, last_msg_at, created_at)
SELECT id, org_id, user_low, user_high, 0, now() - (idx || ' minutes')::interval,
       now() - (idx || ' hours')::interval
FROM new_convos;

INSERT INTO conversation_members (conversation_id, org_id, user_id, visible, hidden_at_seq, last_read_seq, blocked)
SELECT id, org_id, admin_id, true, NULL::bigint, 0, false FROM new_convos
UNION ALL
SELECT id, org_id, peer_id, true, NULL::bigint, 0, false FROM new_convos
ON CONFLICT DO NOTHING;

-- 60 messages per DM: enough for the thread page to page, and enough that the
-- conversation list's last-message lookup has real rows to reach past.
INSERT INTO messages
    (id, org_id, conversation_id, seq, sender_id, body, client_msg_id, created_at,
     is_thread_root, body_enc, is_forward, kind)
SELECT gen_random_uuid(), nc.org_id, nc.id, s,
       CASE WHEN s % 2 = 0 THEN nc.admin_id ELSE nc.peer_id END,
       NULL::text, gen_random_uuid(), now() - (s || ' minutes')::interval,
       false, o.body_enc, false, 'text'
FROM new_convos nc
JOIN org_ref o USING (org_id),
LATERAL generate_series(1, 60) s;

UPDATE conversations c
SET seq_counter = x.n, last_msg_at = x.latest
FROM (SELECT conversation_id, max(seq) AS n, max(created_at) AS latest
      FROM messages GROUP BY conversation_id) x
WHERE c.id = x.conversation_id;

-- inbox_items is deliberately NOT seeded here.
--
-- `item_kind` is constrained to THREAD or TASK — the inbox is built around
-- threads, not conversations, so a row per DM is not a shape the schema
-- accepts and faking one would seed data the application could never have
-- produced. It is also off the measured path: with SKIP_TASK the inbox slot in
-- the load profile is served by /conversations, and the messaging inbox
-- listing has no route in the mix.
--
-- Seeding it properly means seeding `threads` and `thread_members` first, and
-- is worth doing before anyone quotes an inbox number — INFRASTRUCTURE.md
-- expects that read to bind early, and it is the one hot path these two files
-- leave untouched.

COMMIT;

ANALYZE conversations;
ANALYZE conversation_members;
ANALYZE messages;


SELECT 'conversations' AS t, count(*) FROM conversations
UNION ALL SELECT 'messages(dm)', count(*) FROM messages
;
