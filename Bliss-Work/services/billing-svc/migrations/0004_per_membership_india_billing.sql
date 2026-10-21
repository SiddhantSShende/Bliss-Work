-- Phase 6 (revised plan): per-membership billing anchors/trial + India-only
-- gateway groundwork. Additive only — org_billing_state and
-- billing_renewal_runs are intentionally left in place as unused relics
-- rather than dropped (per-org renewal is being replaced by per-membership
-- renewal, not migrated in place), and credit_purchases/credit_packages keep
-- their existing shape so nothing already written against them breaks.

-- Rates confirmed by the business: members cost 2 credits/period, admins 5
-- (up from the phase-2 placeholder seed of 1/3). Plain UPDATE, not
-- INSERT ... ON CONFLICT, because migrations/0002 already guarantees these
-- rows exist — an operator may since have changed them via the pricing API,
-- but that's an explicit business decision this migration intentionally
-- overrides (the new rates are a confirmed rule change, not a default).
UPDATE billing_pricing SET value = '5', updated_at = now() WHERE key = 'admin_monthly_credits';
UPDATE billing_pricing SET value = '2', updated_at = now() WHERE key = 'member_monthly_credits';

-- Per-membership trial + own renewal anchor (each membership renews on its
-- own anniversary, not the org's). cycle_status supersedes the old
-- 'active'/'suspended'/'removed' status for billing-cycle purposes — status
-- stays as the commitment-projection flag (phase 4), cycle_status drives the
-- renewal job. grace_deadline is only meaningful while cycle_status='grace'.
ALTER TABLE org_membership_billing ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE org_membership_billing ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE org_membership_billing ADD COLUMN IF NOT EXISTS anchor_day smallint;
ALTER TABLE org_membership_billing ADD COLUMN IF NOT EXISTS next_renewal_at timestamptz;
ALTER TABLE org_membership_billing ADD COLUMN IF NOT EXISTS grace_deadline timestamptz;
ALTER TABLE org_membership_billing ADD COLUMN IF NOT EXISTS cycle_status text NOT NULL DEFAULT 'active';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'org_membership_billing'::regclass
        AND conname = 'org_membership_billing_cycle_status_check'
    ) THEN
        ALTER TABLE org_membership_billing DROP CONSTRAINT org_membership_billing_cycle_status_check;
    END IF;
    ALTER TABLE org_membership_billing ADD CONSTRAINT org_membership_billing_cycle_status_check
        CHECK (cycle_status IN ('trial', 'active', 'grace', 'suspended', 'removed'));
END $$;

-- Per-membership equivalent of billing_renewal_runs: idempotency/concurrency
-- guard keyed by (org_id, user_id, period_start) instead of (org_id,
-- period_start), since each membership now has its own period.
CREATE TABLE IF NOT EXISTS membership_renewal_runs (
    id             uuid PRIMARY KEY,
    org_id         uuid NOT NULL,
    user_id        uuid NOT NULL,
    period_start   timestamptz NOT NULL,
    period_end     timestamptz NOT NULL,
    credits_due    bigint NOT NULL,
    status         text NOT NULL DEFAULT 'processed',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT membership_renewal_runs_status_check
        CHECK (status IN ('processed', 'insufficient_funds'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_renewal_runs_org_user_period
    ON membership_renewal_runs (org_id, user_id, period_start);

-- India-only gateway groundwork (pricing/audit fields only — no gateway
-- client, webhook route, or FX-fetch code exists yet; see the plan's
-- "payment gateway" section for what's still blocked on legal/product
-- decisions). currency stays 'usd' for existing rows; INR purchases will set
-- currency='inr' and populate these.
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS fx_rate_used numeric;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS fx_rate_source text;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS fx_quoted_at timestamptz;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS base_inr_cents bigint;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS gst_inr_cents bigint;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS gateway_fee_inr_cents bigint;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS total_payable_inr_cents bigint;

-- Config keys the per-membership renewal job and (later) low-credit alerting
-- read from billing_pricing — same operator-gated table, no new authz path.
-- 'usd_to_inr_rate_source' is a PLACEHOLDER value only: the real rate
-- provider (RBI reference rate vs. a commercial FX API vs. gateway-native
-- quoting) is an explicitly unresolved product/legal decision per the plan
-- and must be set to a real source before any INR purchase path is enabled.
INSERT INTO billing_pricing (key, value) VALUES
    ('low_balance_threshold_credits', '20'),
    ('grace_period_days',             '7'),
    ('usd_to_inr_rate_source',        '"unconfigured"')
ON CONFLICT (key) DO NOTHING;
