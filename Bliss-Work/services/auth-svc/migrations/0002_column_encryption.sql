-- 0002: at-rest column encryption — per-org wrapped DEKs + encrypted user columns.
-- Idempotent; additive (the plaintext columns are kept nullable during the
-- dual-write/backfill rollout and dropped by a later migration in prod).

-- Per-org Data Encryption Keys (wrapped by the KEK). All versions retained so
-- DEK rotation is lazy; deleting an org's row crypto-shreds its data.
CREATE TABLE IF NOT EXISTS org_keys (
    org_id      uuid        NOT NULL,
    key_version smallint    NOT NULL,
    wrapped_dek bytea       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,
    PRIMARY KEY (org_id, key_version)
);
CREATE INDEX IF NOT EXISTS idx_org_keys_current ON org_keys (org_id) WHERE retired_at IS NULL;

-- Encrypted PII columns + the deterministic blind index for email login lookup.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_enc        bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_bidx       bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name_enc bytea;

-- New rows store ciphertext; the plaintext columns become nullable so the app
-- can stop writing them (dropped after backfill in the final migration).
ALTER TABLE users ALTER COLUMN email        DROP NOT NULL;
ALTER TABLE users ALTER COLUMN display_name DROP NOT NULL;

-- Login does an equality lookup on the encrypted email via its blind index.
CREATE INDEX IF NOT EXISTS idx_users_email_bidx ON users (email_bidx);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_org_email_bidx ON users (org_id, email_bidx);
