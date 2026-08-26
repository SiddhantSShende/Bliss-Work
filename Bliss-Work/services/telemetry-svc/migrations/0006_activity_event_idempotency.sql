-- 0006_activity_event_idempotency — dedup activity_events on client retry.
--
-- insert_events mints a fresh uuid7 for every row on every call, including a
-- retry: a client that posts a batch, the server commits it, and the response
-- is lost to a network blip retries the SAME events with a fresh id each time
-- (activity-agent.ts's flush() and background.ts's flush() both re-queue on
-- any !res.ok or thrown fetch error — they cannot tell "never arrived" apart
-- from "arrived, committed, ack lost"). Nothing before this migration could
-- catch that: no id is client-supplied, and there was no unique constraint
-- beyond the server-generated primary key. Over-counted duration/sessions was
-- the result — not a security or data-loss issue, but a real correctness gap
-- under the retry-on-failure behavior the clients are deliberately built with.
--
-- `client_event_id` is optional (older/unpatched clients send none, and
-- server-observed rows from the Kafka consumer never have one) — a NULL
-- value is never deduped against another NULL, only a real, repeated id is.
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS client_event_id text;

-- Partitioned tables require every partition-key column (occurred_at) in a
-- unique index — verified against a scratch instance before writing this.
-- A retry keeps the same client-computed occurred_at as the original attempt
-- (clamp_occurred_at only shifts a value when the raw clock reading itself is
-- implausible, not run-to-run on an unchanged input), so including it here
-- does not defeat the dedup for the retries this migration exists to catch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_client_event_id
    ON activity_events (org_id, user_id, occurred_at, client_event_id)
    WHERE client_event_id IS NOT NULL;
