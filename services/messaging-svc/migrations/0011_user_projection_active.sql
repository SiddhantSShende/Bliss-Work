-- Membership lifecycle reaches the messaging projection.
--
-- Until now the auth consumer handled exactly one event type — user.created —
-- so a member who was suspended or removed from the org stayed in this mirror
-- forever, and kept appearing in every picker built from it.
--
-- The row is NOT deleted when someone leaves: messages, channel memberships and
-- forward chains all reference user_id and resolve their sender names through
-- this table, so dropping it would blank the history the member left behind.
-- Only this flag moves.
--
-- Defaults true so every existing row (and any producer that predates the new
-- events) keeps its current meaning. Idempotent — re-runs on every startup.

ALTER TABLE user_projection ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
