-- 0029_call_recordings_one_active_per_call.sql — at most one live egress per call.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── The race this closes ─────────────────────────────────────────────────────
-- StartRecording's insert was idempotent on egress_id (0024), which stops the
-- SAME egress request from forking a row on retry — but it did nothing for two
-- DIFFERENT concurrent "start recording" requests for the same call (two hosts
-- both pressing Record, or a client retrying a request it only THOUGHT had
-- failed). AuthorizeRecordingControl checks who may start a recording, never
-- whether one is already running, so both requests passed it, both minted a
-- real LiveKit egress, and both rows landed as RECORDING — two live egress jobs
-- billing and writing files for one call.
--
-- A partial unique index is the actual guard, not a SELECT-then-INSERT in Go:
-- the same check-then-act gap that created the bug in the first place would
-- just move one layer up. The second concurrent INSERT now hits this
-- constraint and StartRecording (call_recordings.go) turns that into
-- ErrAlreadyRecording instead of a raw pg error.

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_recordings_one_active_per_call
    ON call_recordings (call_id) WHERE status = 'RECORDING';
