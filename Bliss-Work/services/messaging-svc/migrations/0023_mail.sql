-- 0023_mail.sql — the Inbox becomes a mailbox: composed, sent and received email.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── Why this rides on inbox_items instead of a second feed ───────────────────
-- The unified feed (keyset pagination, unread rollups, the People sidebar,
-- hide/delete semantics, the org RLS policy) is already built and already
-- HASH-partitioned by owner. A mail row is exactly what an inbox_items row
-- models: "something addressed to this person at this time". So MAIL joins
-- THREAD and TASK as a third item_kind and inherits all of that unchanged —
-- GET /inbox, GET /inbox/peers, ignore and mark-read keep working with no new
-- list plumbing. The mail-specific state (recipients, bodies, headers) lives in
-- the three tables below and is fetched only when a row is opened.
--
-- ── Encryption posture ───────────────────────────────────────────────────────
-- Mirrors messages.body_enc and attachments.filename_enc: the plaintext columns
-- do not exist, and every human-meaningful field (subject, both bodies, every
-- address, the display name) is stored as ciphertext under the org DEK. Subject
-- lines and recipient lists are at least as sensitive as message bodies —
-- "To: recruiting@competitor.com" leaks the whole story on its own.
--
-- The columns the SERVER must match on stay plaintext because they carry no
-- content: the resolved local user_id (delivery routing), the folder, and the
-- inbound Message-ID (dedup of a redelivered webhook).

-- ─────────────────────────────────────────────────────────────────────────────
-- mail_messages ─ one row per email, in any of its three lives.
--
--   DRAFT    → being composed. Created when the composer opens so attachments
--              have something to hang their authorization off (see the scope
--              note further down). Never appears in anyone's feed.
--   SENT     → left the composer. Immutable from here on.
--   RECEIVED → arrived from outside via the inbound ingestion endpoint.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_messages (
    id                  uuid PRIMARY KEY,          -- uuidv7, app-side
    org_id              uuid NOT NULL,
    status              text NOT NULL CHECK (status IN ('DRAFT', 'SENT', 'RECEIVED')),

    -- The BlissWork user who wrote it. NULL for inbound mail from outside the
    -- org — there is no local account behind that address, which is exactly
    -- what distinguishes it.
    author_user_id      uuid,

    -- The From: header as it should be displayed. Kept even for local authors:
    -- an account's address can change, and a delivered email must keep showing
    -- the address it was actually sent from.
    from_address_enc    bytea,
    from_name_enc       bytea,

    subject_enc         bytea,
    body_text_enc       bytea,
    -- Reserved for inbound multipart/alternative mail. Outbound composition is
    -- plain text today; the column exists so receiving HTML mail does not need
    -- a migration, and readers must treat it as untrusted markup.
    body_html_enc       bytea,

    -- RFC 5322 Message-ID of an inbound mail. Plaintext and UNIQUE per org so a
    -- webhook that redelivers the same message cannot double-deliver it.
    external_message_id text,

    sent_at             timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Abandoned-draft sweep, and the composer's "my open drafts" lookup.
CREATE INDEX IF NOT EXISTS idx_mail_messages_drafts
    ON mail_messages (author_user_id, created_at)
    WHERE status = 'DRAFT';

-- Inbound dedup. Partial because only inbound mail carries a Message-ID, and
-- UNIQUE per org because two orgs can legitimately receive the same broadcast.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_messages_external_id
    ON mail_messages (org_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- mail_recipients ─ the To/Cc/Bcc lists, one row per addressee.
--
-- `position` preserves the order the sender typed, which is part of the header
-- and not ours to reorder. `user_id` is the address resolved against this org's
-- directory at SEND time: non-NULL means "deliver in-app", NULL means "hand to
-- SMTP". Resolving once at send (rather than at every read) is what makes
-- delivery deterministic — a colleague who leaves the org afterwards does not
-- retroactively turn a delivered email into an undelivered one.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_recipients (
    mail_id     uuid NOT NULL REFERENCES mail_messages (id) ON DELETE CASCADE,
    org_id      uuid NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('TO', 'CC', 'BCC')),
    position    int  NOT NULL,
    address_enc bytea NOT NULL,
    user_id     uuid,
    PRIMARY KEY (mail_id, kind, position)
);

CREATE INDEX IF NOT EXISTS idx_mail_recipients_user
    ON mail_recipients (user_id) WHERE user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- mail_deliveries ─ per-(mail, person) mailbox record. The authorization list.
--
-- One row per person who may READ this mail: every local recipient (folder
-- 'INBOX') plus the author (folder 'SENT'). Attachment downloads and GET
-- /mail/{id} both check this table, so a Bcc'd colleague can open the mail
-- while a To: recipient still cannot see that they were Bcc'd — the header
-- projection is filtered separately, but access is settled here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_deliveries (
    mail_id       uuid NOT NULL REFERENCES mail_messages (id) ON DELETE CASCADE,
    owner_user_id uuid NOT NULL,
    org_id        uuid NOT NULL,
    folder        text NOT NULL CHECK (folder IN ('INBOX', 'SENT')),
    read_at       timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mail_id, owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_deliveries_owner
    ON mail_deliveries (owner_user_id, created_at DESC);

-- Address → local user resolution, run once per recipient at SEND time. The
-- existing idx_user_projection_email is on the raw column; addresses are
-- normalized to lower case before lookup (nobody types their colleague's
-- address with consistent capitalisation), so the match needs the expression
-- index or every send sequential-scans the directory.
CREATE INDEX IF NOT EXISTS idx_user_projection_org_email_lower
    ON user_projection (org_id, lower(email))
    WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- inbox_items ─ admit 'MAIL' as a third item_kind.
--
-- The CHECK is replaced rather than dropped: it is the only thing stopping a
-- typo'd kind from becoming an invisible row nobody can explain later.
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
    con text;
    def text;
BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO con, def
    FROM pg_constraint
    WHERE conrelid = 'inbox_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%item_kind%';

    -- Already widened by an earlier run of this file: nothing to do.
    IF con IS NOT NULL AND def ILIKE '%MAIL%' THEN
        RETURN;
    END IF;

    -- The PARENT is what we touch. inbox_items is HASH-partitioned and its 64
    -- partitions INHERIT this constraint rather than declaring their own, so
    -- dropping and re-adding here propagates to all of them.
    IF con IS NOT NULL THEN
        EXECUTE format('ALTER TABLE inbox_items DROP CONSTRAINT %I', con);
    END IF;

    ALTER TABLE inbox_items
        ADD CONSTRAINT inbox_items_item_kind_check
        CHECK (item_kind IN ('THREAD', 'TASK', 'MAIL'));
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- attachments ─ admit 'mail' as a fourth scope.
--
-- The three existing scopes each name a membership table. 'mail' names
-- mail_deliveries, and its scope_id is the mail_messages.id. That is why a
-- draft row is created when the composer OPENS rather than when Send is
-- pressed: an upload has to be authorized against a destination that already
-- exists, and the draft's author row in mail_deliveries is that destination.
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
    con text;
    def text;
BEGIN
    -- Matched on BOTH 'scope' and 'conversation' so this can only ever find the
    -- scope enum: the table's other CHECKs cover size_bytes and role, and
    -- neither mentions a scope name.
    SELECT conname, pg_get_constraintdef(oid) INTO con, def
    FROM pg_constraint
    WHERE conrelid = 'attachments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%scope%'
      AND pg_get_constraintdef(oid) ILIKE '%conversation%';

    IF con IS NOT NULL AND def ILIKE '%mail%' THEN
        RETURN;
    END IF;

    IF con IS NOT NULL THEN
        EXECUTE format('ALTER TABLE attachments DROP CONSTRAINT %I', con);
    END IF;

    ALTER TABLE attachments
        ADD CONSTRAINT attachments_scope_check
        CHECK (scope IN ('conversation', 'thread', 'channel', 'mail'));
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS ─ the three new tables carry org_id, so they get the same org_isolation
-- policy every other org-scoped table in messagingdb has (see 0007_rls.sql for
-- why FORCE, and why an unset app.org_id must see zero rows).
-- ─────────────────────────────────────────────────────────────────────────────
DO $rls$
DECLARE
    t text;
    mail_tables text[] := ARRAY['mail_messages', 'mail_recipients', 'mail_deliveries'];
BEGIN
    FOREACH t IN ARRAY mail_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE policyname = 'org_isolation'
              AND tablename  = t
              AND schemaname = current_schema()
        ) THEN
            EXECUTE format($pol$
                CREATE POLICY org_isolation ON %I
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    WITH CHECK (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
            $pol$, t);
        END IF;
    END LOOP;
END
$rls$;
