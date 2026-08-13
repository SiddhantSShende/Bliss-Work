-- 0006_column_encryption.sql — application-layer at-rest column encryption.
--
-- NOTE: the task spec called this "0005_column_encryption.sql", but 0005 was
-- already taken by 0005_channels_locked.sql, so it lands at 0006 to preserve
-- the lexical migration order (store.Migrate runs files sorted by name).
--
-- This migration is IDEMPOTENT. Every statement guards re-execution.
--
-- Model (mirrors auth-svc): per-org DEK wrapped by a pluggable KEK, stored in
-- org_keys; sensitive text columns gain a `*_enc bytea` sibling holding the
-- self-describing AES-256-GCM ciphertext. The plaintext columns are made
-- NULLABLE so new writes can store ciphertext only (plaintext col left NULL);
-- old rows keep their plaintext until a backfill runs. Encrypt-on-write /
-- decrypt-on-read happens transparently in the store layer.

-- ─────────────────────────────────────────────────────────────────────────────
-- org_keys ─ per-org wrapped Data Encryption Keys. The DEK is created lazily on
-- first write within that write's tx (INSERT ... ON CONFLICT DO NOTHING).
-- Embedding key_version on each ciphertext makes DEK rotation lazy: retire a
-- version by setting retired_at, write under the new one, old rows still read.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_keys (
    org_id      uuid    NOT NULL,
    key_version int     NOT NULL,
    wrapped_dek bytea   NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,
    PRIMARY KEY (org_id, key_version)
);

-- One active (non-retired) DEK per org; the read path selects the newest
-- non-retired version, so the partial index keeps that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_org_keys_active
    ON org_keys (org_id, key_version DESC)
    WHERE retired_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Encrypted sibling columns. ALTER on a partitioned parent (inbox_items)
-- cascades to all partitions automatically, so we only touch the parent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1:1 messages — body.
ALTER TABLE messages          ADD COLUMN IF NOT EXISTS body_enc            bytea;
ALTER TABLE messages          ALTER COLUMN body DROP NOT NULL;

-- Channel messages — body.
ALTER TABLE channel_messages  ADD COLUMN IF NOT EXISTS body_enc            bytea;
ALTER TABLE channel_messages  ALTER COLUMN body DROP NOT NULL;

-- Threads — subject preview shown in the list pane.
ALTER TABLE threads           ADD COLUMN IF NOT EXISTS subject_preview_enc bytea;
ALTER TABLE threads           ALTER COLUMN subject_preview DROP NOT NULL;

-- Unified inbox projection — preview (partitioned parent; cascades).
ALTER TABLE inbox_items       ADD COLUMN IF NOT EXISTS preview_enc         bytea;
ALTER TABLE inbox_items       ALTER COLUMN preview DROP NOT NULL;
