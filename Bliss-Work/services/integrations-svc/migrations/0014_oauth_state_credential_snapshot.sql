-- 0014_oauth_state_credential_snapshot — make the app_credential_id pin actually
-- survive a mid-consent secret rotation, as 0005's own comment already claims.
--
-- ── The gap this closes ──────────────────────────────────────────────────────
-- app_credentials.save() is an upsert: rotating an org's OAuth app secret
-- (PUT /integrations/app-credentials/{vendor}) UPDATEs the SAME row in place —
-- the row's `id` never changes. oauth_states.app_credential_id pins to that
-- `id`, so app_credentials.load_by_id() at callback time returns the CURRENT
-- (rotated) secret, not the one active when the authorize URL was built. The
-- exact "an admin rotates the client secret while a user sits on the consent
-- screen" scenario 0005 documents this pin as solving therefore still fails
-- with an opaque invalid_client — the pin never actually stopped pointing at
-- live, mutable data.
--
-- ── The fix ───────────────────────────────────────────────────────────────────
-- Snapshot the client_id/secret actually resolved at connect_start time
-- directly into the state row, encrypted the same way code_verifier_enc
-- already is. The callback decrypts these instead of re-resolving through
-- app_credentials — so a rotation afterwards genuinely cannot affect an
-- in-flight flow, regardless of whether the credential row's id is reused.
-- app_credential_id itself is kept (still useful for audit/debugging: which
-- credential row this flow started against), just no longer load-bearing for
-- the actual token exchange.
ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS client_id_enc bytea,
    ADD COLUMN IF NOT EXISTS client_secret_enc bytea,
    ADD COLUMN IF NOT EXISTS tenant text;
