-- 0007_identities.sql — cross-org identity (one email+password → many org memberships).
--
-- Idempotent. Runs on every boot.
--
-- Today `users` conflates person + org + credential: the SAME email is a separate
-- `users` row per org, each with its own password_hash, and login resolves the
-- global email blind index with LIMIT 1 (so only one org is reachable). This adds
-- an `identities` row per email (the ONE shared credential) and links every
-- membership to it via `users.identity_id`, so one login reaches all orgs and a
-- switch endpoint can re-mint a token for another membership.
--
-- `identities` is CROSS-ORG (spans orgs) and therefore carries NO org_id and gets
-- NO RLS — same as `refresh_tokens` (0003_rls.sql). It is only ever read/written by
-- trusted auth flows under `app.bypass_rls`.

CREATE TABLE IF NOT EXISTS identities (
    id                 uuid PRIMARY KEY,
    email_bidx         bytea NOT NULL UNIQUE,   -- global HMAC blind index of the email
    password_hash      text  NOT NULL,          -- the ONE shared credential (Argon2)
    email_verified     boolean NOT NULL DEFAULT false,
    failed_login_count int  NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    last_user_id       uuid,                    -- membership (users.id) last used → "open last org"
    created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_id uuid;
CREATE INDEX IF NOT EXISTS idx_users_identity ON users (identity_id);

-- Backfill (idempotent): one identity per distinct email_bidx, seeded from the row
-- login would currently pick (active-then-oldest) — so the consolidated credential
-- is exactly the one that already works; the other per-org passwords were already
-- unreachable via login (LIMIT 1), so nobody loses access.
INSERT INTO identities
    (id, email_bidx, password_hash, email_verified, failed_login_count, locked_until, last_user_id)
SELECT gen_random_uuid(), p.email_bidx, p.password_hash, p.email_verified,
       COALESCE(p.failed_login_count, 0), p.locked_until, p.id
FROM (
    SELECT DISTINCT ON (email_bidx)
           email_bidx, id, password_hash, email_verified, failed_login_count, locked_until
    FROM users
    WHERE email_bidx IS NOT NULL
    ORDER BY email_bidx, (status = 'active') DESC, created_at ASC
) p
ON CONFLICT (email_bidx) DO NOTHING;

-- Link every (still-unlinked) membership to its identity.
UPDATE users u
   SET identity_id = i.id
  FROM identities i
 WHERE u.email_bidx = i.email_bidx
   AND u.identity_id IS NULL;
