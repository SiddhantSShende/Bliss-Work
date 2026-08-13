-- Membership lifecycle reaches the task projection.
--
-- Mirrors messaging-svc/migrations/0011_user_projection_active.sql. Until now
-- the auth consumer handled only user.created, so someone suspended or removed
-- from the org kept showing up in the Available roster and the assignee picker.
--
-- The row is NOT deleted: tasks reference assignee and allocator ids and
-- resolve their names through this table, so a departed member's completed work
-- must still render with their name on it. Only this flag moves.
--
-- Defaults true so every existing row keeps its current meaning. Idempotent.

ALTER TABLE user_projection ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
