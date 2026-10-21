-- Step 4 (low-credit notifications): per-org dedup/reset state for the
-- `membership.low_balance` outbox event.
--
-- One row per org. `armed` is true whenever the org's balance is at or above
-- `low_balance_threshold_credits` (billing_pricing) — crossing back above the
-- threshold re-arms it (see app/ledger.py). While armed, the NEXT debit that
-- takes the balance below the threshold fires exactly one event and flips
-- `armed` to false, recording `last_alerted_on`. A later debit that same
-- calendar day with the balance still below threshold is a no-op (armed is
-- already false and last_alerted_on is already today); the day after, with
-- the balance still below threshold, `last_alerted_on <> current_date` fires
-- it again without needing a top-up in between — "alert once per org per day
-- while under the threshold", per the plan.
CREATE TABLE IF NOT EXISTS org_low_balance_alert_state (
    org_id          uuid PRIMARY KEY,
    armed           boolean NOT NULL DEFAULT true,
    last_alerted_on date,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
