-- 003: at-rest column encryption — per-org wrapped DEKs + encrypted task columns.
-- Idempotent; additive (the plaintext columns are kept nullable during the
-- dual-write/backfill rollout and dropped by a later migration in prod).
--
-- NOTE: requested as "002_column_encryption.sql" but 002 is already taken by
-- 002_tasks_channels.sql; numbered 003 so it sorts AFTER init and runs cleanly
-- under db.run_migrations() (lexical order).

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

-- Encrypted task columns. New rows store ciphertext in *_enc; the plaintext
-- columns become nullable so the app can stop writing them (dropped after
-- backfill in the final migration).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title_enc       bytea;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description_enc bytea;

ALTER TABLE tasks ALTER COLUMN title       DROP NOT NULL;
ALTER TABLE tasks ALTER COLUMN description DROP NOT NULL;
