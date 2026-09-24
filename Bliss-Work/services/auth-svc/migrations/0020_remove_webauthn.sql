-- Remove the Passkey/WebAuthn MFA feature.
--
-- TOTP state and backup codes remain in place. The credential table and the
-- challenge purpose were dedicated to WebAuthn and are no longer used.
DROP TABLE IF EXISTS mfa_webauthn_credentials;

ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_purpose_chk;
ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_purpose_chk
    CHECK (purpose IN ('password_reset', 'email_verify', 'mfa_pending'));
