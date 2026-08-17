-- Seed messagingdb with a realistic data volume for load testing.
--
-- ── Why this exists ──────────────────────────────────────────────────────────
-- The first capacity run measured a database holding 1,131 messages and 43
-- users. Every query hit tables small enough to sit entirely in shared buffers
-- with trivial index scans, so it measured parsing and network overhead rather
-- than the query plans that actually bind in production. The two dominant reads
-- — the channel list (a member-count aggregate plus a LATERAL last-message
-- lookup, decrypted per row) and the message page (keyset pagination) — were
-- both effectively free.
--
-- ── The encryption trick, and why it is honest ───────────────────────────────
-- Message bodies are encrypted per org (`body_enc`), so rows inserted with a
-- plaintext `body` and a NULL `body_enc` would skip the decrypt entirely —
-- `decryptChannelRow` falls back to the plaintext column — and would understate
-- the cost of exactly the path under test.
--
-- So every seeded row REUSES a real ciphertext already present in that same
-- org, produced by the application through its own org DEK. The decrypt on the
-- read path therefore does genuine AEAD work against a genuine key. The
-- plaintext is identical across rows, which affects nothing: decryption cost is
-- set by length and by the key lookup, not by the message content.
--
-- Run as a superuser (RLS is FORCE'd on these tables):
--   docker exec -i task-board-postgres-1 psql -U taskboard -d messagingdb -f -

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- One real ciphertext and one real admin per org. The admin is whoever already
-- sent a message there, which for the load-test pool is the account itself.
CREATE TEMP TABLE org_ref ON COMMIT DROP AS
SELECT org_id,
       (array_agg(body_enc ORDER BY created_at))[1] AS body_enc,
       (array_agg(sender_id ORDER BY created_at))[1] AS admin_id
FROM channel_messages
WHERE body_enc IS NOT NULL
GROUP BY org_id;

-- Colleagues. The member-count aggregate in ListChannels is only meaningful if
-- channels have more than one person in them.
INSERT INTO user_projection (user_id, org_id, username, display_name, email, active)
SELECT gen_random_uuid(), o.org_id, 'seed' || o.org_id || '-' || g,
       'Seed User ' || g, 'seed-' || o.org_id || '-' || g || '@lt.local', true
FROM org_ref o, generate_series(1, 50) g;

-- 200 channels per org: enough that `/channels/open` actually pages (its hard
-- max is 200 per request) instead of returning everything in one go.
CREATE TEMP TABLE new_channels ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, o.org_id, 'seed-ch-' || g AS name,
       o.admin_id AS created_by, g AS idx
FROM org_ref o, generate_series(1, 200) g;

INSERT INTO channels (id, org_id, name, seq_counter, created_by, last_msg_at, created_at, is_locked)
SELECT id, org_id, name, 0, created_by, now(), now() - (idx || ' hours')::interval, false
FROM new_channels;

-- 35 members each. This is what makes the counts CTE do real work.
INSERT INTO channel_members (channel_id, org_id, user_id, joined_at, role)
SELECT nc.id, nc.org_id, u.user_id, now(), 'member'
FROM new_channels nc
JOIN LATERAL (
    SELECT up.user_id FROM user_projection up
    WHERE up.org_id = nc.org_id
    LIMIT 35
) u ON true
ON CONFLICT DO NOTHING;

-- The account the load test drives joins the first 30, so its own channel list
-- is a realistic size rather than one row.
INSERT INTO channel_members (channel_id, org_id, user_id, joined_at, role)
SELECT nc.id, nc.org_id, o.admin_id, now(), 'admin'
FROM new_channels nc JOIN org_ref o USING (org_id)
WHERE nc.idx <= 30
ON CONFLICT DO NOTHING;

-- Messages. Deep in the channels the test reads (500 each, so keyset pagination
-- has something to page over), shallow elsewhere (10) so the table is broad
-- without being pointlessly enormous.
INSERT INTO channel_messages
    (id, org_id, channel_id, seq, sender_id, body, client_msg_id, created_at, body_enc, kind)
SELECT gen_random_uuid(), nc.org_id, nc.id, s, o.admin_id, NULL,
       gen_random_uuid(), now() - (s || ' minutes')::interval, o.body_enc, 'text'
FROM new_channels nc
JOIN org_ref o USING (org_id),
LATERAL generate_series(1, CASE WHEN nc.idx <= 30 THEN 500 ELSE 10 END) s;

-- Keep the counters consistent with the rows, so a send during the run gets a
-- seq past the seeded ones rather than colliding on (channel_id, seq).
UPDATE channels c
SET seq_counter = x.n, last_msg_at = x.latest
FROM (
    SELECT channel_id, max(seq) AS n, max(created_at) AS latest
    FROM channel_messages GROUP BY channel_id
) x
WHERE c.id = x.channel_id;

COMMIT;

ANALYZE channel_messages;
ANALYZE channel_members;
ANALYZE channels;
ANALYZE user_projection;

SELECT 'channels' AS t, count(*) FROM channels
UNION ALL SELECT 'channel_members', count(*) FROM channel_members
UNION ALL SELECT 'channel_messages', count(*) FROM channel_messages
UNION ALL SELECT 'user_projection', count(*) FROM user_projection;
