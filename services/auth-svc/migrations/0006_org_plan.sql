-- 0006_org_plan.sql — per-org subscription plan (entitlements). Idempotent.
--
-- 'free' (default) | 'standard' | 'enterprise'. The External Integrations +
-- message forward-tracking feature is gated to 'enterprise'. Gating is enforced
-- SERVER-SIDE in each service from the `plan` access-token claim (auth-svc mints
-- it here), and mirrored in the UI. Changing an org's plan takes effect on the
-- org's next token mint/refresh (≤ the access-token TTL).
ALTER TABLE orgs
    ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
        CHECK (plan IN ('free', 'standard', 'enterprise'));
