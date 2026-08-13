-- 0010_attachments.sql — persisted chat attachments (media, files, thumbnails).
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── What lives where ─────────────────────────────────────────────────────────
-- The BYTES live on a local volume, content-addressed and sharded by org (see
-- internal/blob). This table is the metadata and, more importantly, the
-- AUTHORIZATION record.
--
-- ── Why authorization hangs off (scope, scope_id) ────────────────────────────
-- The obvious design — "you may read an attachment if you can read a message
-- that references it" — is unimplementable here: message bodies are encrypted
-- (messages.body_enc), so the SERVER CANNOT SEE which attachment a message
-- refers to. Instead the uploader names the destination up front; we verify
-- membership at UPLOAD, store it, and RE-VERIFY membership at every DOWNLOAD.
-- The three scopes cover all four send paths:
--   'conversation' → DMs           (conversation_members)
--   'thread'       → Inbox threads (thread_members)
--   'channel'      → channels      (channel_members)
--
-- ── Encryption posture (deliberately asymmetric) ─────────────────────────────
-- filename is encrypted under the org DEK exactly like messages.body_enc —
-- filenames leak content ("Q3-layoffs-final.xlsx" says plenty on its own).
-- The BLOB BYTES are NOT application-layer encrypted: crypto.Cryptor is a
-- whole-value API (string in, []byte out), so encrypting a 100 MB upload would
-- need the entire file resident twice in a memory-capped container, and
-- AES-GCM is not seekable, which would break HTTP Range — i.e. video seeking.
-- The bytes are protected by filesystem permissions and volume-level encryption.
-- A future move to AES-CTR (seekable, per-attachment key wrapped by the org DEK)
-- can be made without changing this schema.

CREATE TABLE IF NOT EXISTS attachments (
    id                   uuid PRIMARY KEY,
    org_id               uuid NOT NULL,
    uploader_id          uuid NOT NULL,

    -- Authorization target, verified at upload and re-verified at download.
    scope                text NOT NULL CHECK (scope IN ('conversation','thread','channel')),
    scope_id             uuid NOT NULL,

    -- 'thumb' rows are client-generated posters. They inherit the parent's ACL
    -- and are removed with it (ON DELETE CASCADE).
    role                 text NOT NULL DEFAULT 'file' CHECK (role IN ('file','thumb')),
    parent_attachment_id uuid REFERENCES attachments (id) ON DELETE CASCADE,

    sha256               char(64) NOT NULL,
    -- SERVER-SNIFFED, never the client's declared type. See internal/media.Sniff:
    -- trusting a client Content-Type is how "image/png" becomes stored XSS.
    mime                 text NOT NULL,
    size_bytes           bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 104857600),

    -- Mirrors the messages.body / body_enc pair: plaintext column stays NULL,
    -- the ciphertext sibling is the source of truth.
    filename             text,
    filename_enc         bytea,

    -- Client-supplied layout hints so the bubble can reserve space and avoid
    -- layout shift. DISPLAY-ONLY and untrusted: a lying client only ruins its
    -- own rendering, so these are deliberately not validated.
    width                int,
    height               int,
    duration_ms          int,

    storage_path         text NOT NULL,   -- relative to MEDIA_ROOT

    -- Orphan reaper. Set to created_at + 24h on upload and NULLed by
    -- POST /attachments/{id}/commit once the referencing message has landed.
    -- Necessary because the reference lives inside an ENCRYPTED body: if the
    -- user abandons the send, nothing on the server can ever discover that this
    -- blob is unreachable, so uploads are expiring-by-default and made durable
    -- only on explicit commit.
    expires_at           timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);

-- Per-scope listing (a future "files in this channel" pane) and the reaper's
-- org-scoped sweeps.
CREATE INDEX IF NOT EXISTS idx_attachments_scope
    ON attachments (org_id, scope, scope_id, created_at DESC);

-- Reference counting before unlinking a blob: the same content may be attached
-- more than once within an org, so a delete must check for siblings.
CREATE INDEX IF NOT EXISTS idx_attachments_sha
    ON attachments (org_id, sha256);

-- Reaper scan. Partial, so it only indexes the rows still awaiting commit
-- rather than the whole (permanent) table.
CREATE INDEX IF NOT EXISTS idx_attachments_expiring
    ON attachments (expires_at) WHERE expires_at IS NOT NULL;

-- Rolling per-org upload quota (MEDIA_ORG_DAILY_BYTES) — a filesystem has no
-- quotas of its own, so this is the only thing standing between one org and a
-- full volume for everyone.
CREATE INDEX IF NOT EXISTS idx_attachments_org_recent
    ON attachments (org_id, created_at DESC);

-- Thumbnail lookup / cascade support.
CREATE INDEX IF NOT EXISTS idx_attachments_parent
    ON attachments (parent_attachment_id) WHERE parent_attachment_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS ─ declared INLINE (identical policy body to 0007_rls.sql).
--
-- 0007 sorts BEFORE 0010, so on a fresh database 0007's loop hits its
-- pg_tables existence check and skips `attachments` entirely — it would only be
-- protected from the SECOND boot onward. Declaring it here closes that window.
-- 0007's org_tables[] also lists 'attachments' for documentation and
-- re-assertion; both are idempotent. Same pattern as 0008_forwards.sql.
--
-- FORCE (not just ENABLE) because messaging-svc connects as the table OWNER,
-- and a plain ENABLE is bypassed by the owner.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE  ROW LEVEL SECURITY;
DO $at$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation'
          AND tablename  = 'attachments'
          AND schemaname = current_schema()
    ) THEN
        EXECUTE $pol$
            CREATE POLICY org_isolation ON attachments
                USING (
                    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                    OR current_setting('app.bypass_rls', true) = 'on'
                )
                WITH CHECK (
                    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                    OR current_setting('app.bypass_rls', true) = 'on'
                )
        $pol$;
    END IF;
END
$at$;
