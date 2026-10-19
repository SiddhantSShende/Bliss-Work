-- Phase 1: schema only. No enforcement, no app logic reads/writes these yet.
-- billing-svc owns its own database (separate from auth-svc's orgdb), so
-- org_id / user_id here are plain uuid columns with no cross-database FK.

-- One row per org: the current spendable balance. The ledger below is the
-- source of truth for how it got there; this is a materialized total kept in
-- sync by the application in the same transaction as each ledger insert
-- (phase 2), so balance is never computed by summing the ledger on the
-- request path.
CREATE TABLE IF NOT EXISTS billing_accounts (
    org_id     uuid PRIMARY KEY,
    balance    bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_accounts_balance_non_negative CHECK (balance >= 0)
);

-- Append-only. Every balance change (purchase, monthly grant, renewal debit,
-- manual adjustment) is one row here; balance_after is the account balance
-- immediately after this entry, for audit/replay. idempotency_key lets a
-- caller (e.g. the renewal worker) safely retry a debit without double-charging.
CREATE TABLE IF NOT EXISTS credit_ledger (
    id              uuid PRIMARY KEY,
    org_id          uuid NOT NULL,
    delta           bigint NOT NULL,
    balance_after   bigint NOT NULL,
    reason          text NOT NULL,
    reference_type  text,
    reference_id    text,
    idempotency_key text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_org_created ON credit_ledger (org_id, created_at);
-- Partial unique index (not all entries carry a key) — this is what makes a
-- retried debit/credit a no-op instead of a double-grant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_org_idempotency
    ON credit_ledger (org_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Configurable prepaid packages an org can purchase (e.g. "500 credits / $500").
CREATE TABLE IF NOT EXISTS credit_packages (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    credits    bigint NOT NULL,
    price_cents bigint NOT NULL,
    currency   text NOT NULL DEFAULT 'usd',
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    CONSTRAINT credit_packages_credits_positive CHECK (credits > 0),
    CONSTRAINT credit_packages_price_non_negative CHECK (price_cents >= 0)
);

-- One row per purchase attempt. status transitions pending -> completed /
-- failed / refunded. Credits are granted to credit_ledger ONLY when a
-- verified payment-VM event marks a purchase completed (phase 4) — never
-- from this table's existence alone.
CREATE TABLE IF NOT EXISTS credit_purchases (
    id                uuid PRIMARY KEY,
    org_id            uuid NOT NULL,
    package_id        uuid REFERENCES credit_packages (id),
    credits           bigint NOT NULL,
    amount_cents      bigint NOT NULL,
    currency          text NOT NULL DEFAULT 'usd',
    payment_provider  text,
    payment_reference text,
    status            text NOT NULL DEFAULT 'pending',
    created_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    CONSTRAINT credit_purchases_status_check
        CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    CONSTRAINT credit_purchases_credits_positive CHECK (credits > 0)
);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_org ON credit_purchases (org_id, created_at);
-- A given payment-provider reference must settle at most one purchase.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_purchases_payment_reference
    ON credit_purchases (payment_provider, payment_reference)
    WHERE payment_reference IS NOT NULL;

-- Global pricing/config, keyed, e.g. 'admin_monthly_credits' -> '3',
-- 'member_monthly_credits' -> '1'. Not org-scoped: one platform-wide value
-- per key, editable only by a platform operator (phase 3).
CREATE TABLE IF NOT EXISTS billing_pricing (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);

-- Platform-operator allowlist: who may use the operator-only pricing UI /
-- endpoints (distinct from any org's org_admin role — this is platform-wide).
CREATE TABLE IF NOT EXISTS platform_operators (
    user_id    uuid PRIMARY KEY,
    granted_at timestamptz NOT NULL DEFAULT now(),
    granted_by uuid
);

-- Per-org renewal/suspension state. next_renewal_at is anchored to the org's
-- created_at (day-of-month), clamped to the last valid day of shorter months;
-- the renewal worker (phase 5) owns advancing it.
CREATE TABLE IF NOT EXISTS org_billing_state (
    org_id                  uuid PRIMARY KEY,
    anchor_day              smallint NOT NULL,
    next_renewal_at         timestamptz NOT NULL,
    last_renewal_at         timestamptz,
    status                  text NOT NULL DEFAULT 'active',
    grace_deadline          timestamptz,
    outstanding_credits     bigint NOT NULL DEFAULT 0,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT org_billing_state_status_check
        CHECK (status IN ('active', 'grace', 'suspended')),
    CONSTRAINT org_billing_state_anchor_day_check
        CHECK (anchor_day BETWEEN 1 AND 31),
    CONSTRAINT org_billing_state_outstanding_non_negative
        CHECK (outstanding_credits >= 0)
);

-- Per-member monthly-credit entitlement and suspension status.
-- monthly_credits is what the CURRENT period already charged;
-- pending_monthly_credits is what a role change takes effect as at the NEXT
-- renewal (role changes affect the next renewal, not the current one).
CREATE TABLE IF NOT EXISTS org_membership_billing (
    org_id                   uuid NOT NULL,
    user_id                  uuid NOT NULL,
    monthly_credits          bigint NOT NULL,
    pending_monthly_credits  bigint,
    status                   text NOT NULL DEFAULT 'active',
    suspended_at             timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id),
    CONSTRAINT org_membership_billing_status_check
        CHECK (status IN ('active', 'suspended'))
);

-- One row per org per billing period the renewal worker has processed.
-- The unique (org_id, period_start) is what makes the renewal worker's debit
-- idempotent and prevents a stale/retried job from charging a period twice
-- or extending a grace period that already started.
CREATE TABLE IF NOT EXISTS billing_renewal_runs (
    id             uuid PRIMARY KEY,
    org_id         uuid NOT NULL,
    period_start   timestamptz NOT NULL,
    period_end     timestamptz NOT NULL,
    credits_due    bigint NOT NULL,
    status         text NOT NULL DEFAULT 'processed',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_renewal_runs_status_check
        CHECK (status IN ('processed', 'insufficient_funds'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_renewal_runs_org_period
    ON billing_renewal_runs (org_id, period_start);

-- Outbox, same transactional-outbox pattern as every other service
-- (task-svc/app/outbox.py): this service's poller is the ONLY path that
-- emits events to Kafka (topic convention: "billing.events.v1").
CREATE TABLE IF NOT EXISTS outbox (
    id          uuid PRIMARY KEY,
    topic       text NOT NULL,
    kafka_key   text NOT NULL,
    payload     jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
