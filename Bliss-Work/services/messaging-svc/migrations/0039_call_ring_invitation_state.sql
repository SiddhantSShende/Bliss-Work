-- 0039_call_ring_invitation_state.sql — server-authoritative ring timeouts.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── Why this exists ──────────────────────────────────────────────────────────
-- Before this, a call_participants row had exactly two attendance facts:
-- joined_at and left_at. There was no record of HAVING BEEN RUNG — no deadline
-- by which a non-answer becomes a miss, and no way to tell "declined" from
-- "never responded" from "still ringing". That made a server-authoritative
-- ring timeout impossible: nothing short-lived could be swept, and nothing
-- distinguished an explicit decline (which should stop ringing immediately,
-- distinctly from a timeout) from silence.
--
-- ring_expires_at   set the instant a ring goes out (CreateDirectCall,
--                   CreateConferenceCall, AddParticipant); NULL once the
--                   person joins, declines, or the sweep has already resolved
--                   the expiry. The sweep's own deadline, not a client timer —
--                   a client's countdown is cosmetic, this is what a late
--                   join is actually checked against.
-- declined_at       set by the explicit decline endpoint. Distinguishes a
--                   real "no" from a timeout in the text a caller is shown
--                   and in what gets swept: a declined row is never picked up
--                   by the ring-expiry sweep (it already has an answer).
-- missed_at         set by the ring-expiry sweep when ring_expires_at passes
--                   with nobody having joined or declined. Kept (not just
--                   inferred from ring_expires_at having been cleared)
--                   because joining ALSO clears ring_expires_at — missed_at is
--                   what tells a true miss apart from an ordinary answer.
--
-- All three are nullable and default NULL: every existing row, and every
-- scheduled MEETING or CHANNEL call that never goes through a ring at all,
-- simply never sets them.

ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS ring_expires_at timestamptz;
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS declined_at timestamptz;
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS missed_at timestamptz;

-- The sweep's own claim query filters on ring_expires_at while it is NOT NULL
-- and in the past; this index keeps that a cheap lookup instead of a scan of
-- every participant row, including the vast majority with no ring at all.
CREATE INDEX IF NOT EXISTS call_participants_ring_expires_at_idx
    ON call_participants (ring_expires_at)
    WHERE ring_expires_at IS NOT NULL;
