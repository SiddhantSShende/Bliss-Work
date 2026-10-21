-- Phase 7: Cashfree payment gateway + credit purchases. Additive only.
--
-- Extends credit_purchases (already carrying fx_rate_used/fx_rate_source/
-- fx_quoted_at/base_inr_cents/gst_inr_cents/gateway_fee_inr_cents/
-- total_payable_inr_cents from migrations/0004) with the fields needed to
-- drive the purchase-initiation endpoint, Cashfree order creation, and the
-- webhook reconciliation path end to end.

ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS idempotency_key text;
-- A retry with the same client-supplied idempotency key must return the
-- SAME pending/terminal purchase row, never create a second one. Scoped to
-- org_id (not global) so two different orgs can't collide on a client-chosen
-- key, mirroring credit_ledger's (org_id, idempotency_key) convention.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_purchases_org_idempotency
    ON credit_purchases (org_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS requested_credits bigint;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS display_currency text;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS display_currency_amount numeric;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS uplift_pct numeric;
-- Full server-computed quote snapshot (pre/post-uplift amounts, GST base
-- used, FX rate + source, display-currency conversion) kept verbatim for
-- audit — the breakdown returned to the caller at quote time is exactly
-- this, never recomputed differently later.
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS calculation_breakdown jsonb;

-- Cashfree-specific fields for reconciliation. gateway_order_id is the id we
-- send TO Cashfree (our own order_id in their create-order payload);
-- payment_reference (existing column, migrations/0001) is reused to store
-- Cashfree's own cf_order_id / cf_payment_id once known, and its existing
-- unique (payment_provider, payment_reference) index is what makes the
-- webhook handler's row lookup collision-safe — no new index needed there.
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS gateway_order_id text;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS gateway_payment_session_id text;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS gateway_cf_order_id text;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS gateway_last_event jsonb;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS failed_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_purchases_gateway_order_id
    ON credit_purchases (gateway_order_id)
    WHERE gateway_order_id IS NOT NULL;

-- credit_purchases.status already allows 'pending'/'completed'/'failed'/
-- 'refunded' (migrations/0001). Add 'expired' for a Cashfree order that
-- times out without a terminal webhook ever arriving.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'credit_purchases'::regclass
        AND conname = 'credit_purchases_status_check'
    ) THEN
        ALTER TABLE credit_purchases DROP CONSTRAINT credit_purchases_status_check;
    END IF;
    ALTER TABLE credit_purchases ADD CONSTRAINT credit_purchases_status_check
        CHECK (status IN ('pending', 'completed', 'failed', 'refunded', 'expired'));
END $$;

-- Small FX-rate cache: avoids hammering the live provider on every quote.
-- TTL is enforced in application code (app/fx.py), not here — this table is
-- just storage, keyed by currency pair + source so a provider swap doesn't
-- collide with stale rows from a different source.
CREATE TABLE IF NOT EXISTS fx_rate_cache (
    currency_pair text NOT NULL,
    source        text NOT NULL,
    rate          numeric NOT NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (currency_pair, source)
);

-- Config: Cashfree enablement + GST/uplift rates, read from billing_pricing
-- the same way the renewal job reads its own config keys. All default to
-- the conservative/disabled state; real values are set by an operator (or
-- env-driven override in app/cashfree.py) before go-live.
INSERT INTO billing_pricing (key, value) VALUES
    ('cashfree_enabled',           'false'),
    ('credit_uplift_pct',          '2'),
    ('credit_gst_pct',             '18'),
    ('first_purchase_min_credits', '10'),
    ('fx_rate_cache_ttl_seconds',  '3600')
ON CONFLICT (key) DO NOTHING;
