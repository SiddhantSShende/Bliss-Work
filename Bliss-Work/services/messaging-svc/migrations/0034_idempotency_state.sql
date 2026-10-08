-- 0034_idempotency_state.sql — idempotency_keys learns what became of a claim.
--
-- This migration is IDEMPOTENT and ADDITIVE. Store.Migrate runs a file whenever
-- its checksum is not yet in the ledger, and prod runs old and new replicas side
-- by side during a rollout. Every statement guards re-execution, and nothing here
-- removes or renames what the previous release reads or writes.
--
-- Until now a row meant only "this key was claimed", so a retry that arrived
-- while the original was still running, or after it crashed, got a silent 204
-- and the work never happened (or never finished) — for the 24h the row lives.
-- The middleware now needs to tell three situations apart:
--
--   in_progress  claimed, handler still running (or died). `updated_at` is when
--                it was claimed; a claim older than the staleness window is
--                taken over instead of blocking the key.
--   done         handler finished 2xx. response_* hold what it answered so a
--                replay returns the same thing instead of a bare 204.
--
-- `route` binds the key to the request (METHOD + path) that claimed it, so one
-- key cannot be spent on a different action.
--
-- Defaults make every row an OLD replica writes — it inserts only (user_id, key)
-- — read exactly as before: state 'done', route '' (matches any route),
-- no stored response (replays as 204).
ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS route           text        NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS state           text        NOT NULL DEFAULT 'done',
    ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS response_status integer,
    ADD COLUMN IF NOT EXISTS response_type   text,
    ADD COLUMN IF NOT EXISTS response_body   bytea;
