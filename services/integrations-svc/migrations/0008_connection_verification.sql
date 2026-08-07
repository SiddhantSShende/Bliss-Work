-- 0008_connection_verification.sql — proof that a connection actually works.
-- Idempotent; replayed on every boot by db.py::run_migrations.
--
-- Validating WhatsApp credentials at connect time only proves the token can
-- READ the number's metadata (GET /{phone_number_id}). It proves nothing about
-- sending, and nothing about the inbound webhook — so a connection could sit
-- there reading "Connected" while being completely inert. This table backs the
-- round trip that closes that gap: we send a code to the admin's own WhatsApp
-- number through the org's own credentials and hold the connection at
-- status='pending' until the code comes back (typed into the UI, or replied to
-- the business number, which additionally proves inbound delivery).
--
-- Only the SHA-256 is persisted, never the code — same rule as auth-svc's
-- user_tokens (0005_user_tokens_and_hardening.sql). The digest is over
-- "{connection_id}:{code}" so a 6-digit space can't be rainbowed across rows.
--
-- One outstanding verification per connection (PK on connection_id): re-issuing
-- REPLACES the previous code rather than leaving several live at once.
CREATE TABLE IF NOT EXISTS connection_verifications (
    connection_id uuid PRIMARY KEY
                    REFERENCES integration_connections(id) ON DELETE CASCADE,
    org_id        uuid NOT NULL,
    code_hash     bytea NOT NULL,
    -- The admin's own number. PII → encrypted under the org's envelope key.
    target_enc    bytea,
    attempts      int NOT NULL DEFAULT 0,
    last_sent_at  timestamptz,
    expires_at    timestamptz NOT NULL,
    confirmed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS lives HERE, not in 0002_rls.sql. 0002 runs first in lexical order, and its
-- table list is guarded by a "skip if not present yet" CONTINUE — so adding this
-- table there would silently do nothing on the boot that creates it and only
-- take effect on the NEXT restart. A table that is unprotected for one boot is
-- not protected. Policy text is copied verbatim from 0002.
DO $$
BEGIN
    ALTER TABLE connection_verifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE connection_verifications FORCE ROW LEVEL SECURITY;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE policyname = 'org_isolation' AND tablename = 'connection_verifications'
    ) THEN
        CREATE POLICY org_isolation ON connection_verifications
            USING (
              org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.bypass_rls', true) = 'on'
            )
            WITH CHECK (
              org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.bypass_rls', true) = 'on'
            );
    END IF;
END $$;

-- Sweep target for expired, never-confirmed rows.
CREATE INDEX IF NOT EXISTS idx_connection_verifications_expiry
    ON connection_verifications (expires_at)
    WHERE confirmed_at IS NULL;
