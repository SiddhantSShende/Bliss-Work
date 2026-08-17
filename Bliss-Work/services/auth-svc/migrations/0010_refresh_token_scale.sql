-- 0010_refresh_token_scale.sql — make refresh_tokens survive its own write rate.
--
-- refresh_tokens is the highest-write table in the platform and the only one
-- whose load scales with CONCURRENT USERS rather than with activity. Every
-- access-token expiry costs one /auth/refresh, and refresh ROTATES: it inserts a
-- new row and revokes the old one. So the write rate is (concurrent sessions ÷
-- access-token TTL), continuously, whether or not anyone is doing anything.
--
-- Two problems with the original shape, neither visible at small scale.
--
-- ── 1. Revoking a user's sessions was a sequential scan ──────────────────────
-- The table had exactly two indexes: the UNIQUE on token_hash (which makes the
-- hot refresh lookup fast — that part was already right) and one on family_id.
-- There was NO index on user_id, and `revoke_all_user_tokens` is
--
--     UPDATE refresh_tokens SET revoked = true WHERE user_id = :uid
--
-- so every password reset, every deactivation and every removal scanned the
-- whole table. Those are exactly the moments you least want to be slow, because
-- they are the moments where the delay is measured in "how long does a
-- compromised session stay alive".
--
-- ── 2. Nothing ever deleted a row ────────────────────────────────────────────
-- Rotation inserts one row per refresh and marks its predecessor revoked. No job
-- deleted anything, so the table grew forever — one row per refresh, per user,
-- for the life of the deployment. The failure is slow and then sudden: the index
-- outgrows memory, autovacuum falls behind (the PostgresDeadTuplesHigh alert in
-- infra/observability fires on precisely this), and the hot path degrades even
-- though its own query is a perfectly good index lookup.
--
-- ── Why pruning is safe, and where the line is ───────────────────────────────
-- A revoked row is not dead weight: it is what makes REUSE DETECTION work. When
-- a rotated-away token is presented again, its row is found, seen to be revoked,
-- and the whole family is torn down — that is the theft signal. Delete the row
-- and the same replay looks like an unknown token: still rejected, but no longer
-- recognised as theft, and the thief's other stolen tokens survive.
--
-- So the retention line is EXPIRY, not revocation. Past expires_at a replay is
-- refused on expiry grounds regardless, and the row has no further evidentiary
-- value. jobs/prune_refresh_tokens.py deletes on that rule and nothing looser.

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- "All of this user's tokens" — the revoke-everything path.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
    ON refresh_tokens (user_id);

-- The prune's scan. BRIN rather than btree, deliberately: expires_at is
-- effectively append-ordered (rows are inserted with now() + a fixed TTL), which
-- is the access pattern BRIN is built for. It costs a few kilobytes against a
-- btree's gigabytes on a table this size, and the prune only needs to find a
-- contiguous range of old rows rather than seek to one.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_brin
    ON refresh_tokens USING brin (expires_at);
