-- 0015_supersede_duplicate_pending_invites.sql
--
-- invites is RLS-protected (org_isolation policy, FORCE ROW LEVEL SECURITY —
-- applies even to the table owner) and this UPDATE runs with no org context,
-- so without app/db.py setting app.bypass_rls for every migration statement,
-- this silently matched zero rows: no error, ledger still recorded it as
-- applied, and the duplicate below survived to keep failing
-- 0016_invite_pending_uniqueness.sql's CREATE UNIQUE INDEX every restart.
--
-- Cleanup step for 0016_invite_pending_uniqueness.sql's partial unique index
-- on (org_id, email) WHERE status = 'pending'. Split into its own migration
-- file (rather than living in the same file as the CREATE UNIQUE INDEX, as
-- it originally did) because each migration file runs in its own unit of
-- work in services/auth-svc/app/db.py's runner: bundling the cleanup and the
-- index creation together meant that when the index creation failed on
-- pre-existing duplicates, the cleanup that had just fixed them was rolled
-- back right along with it — every retry hit the exact same duplicates,
-- forever. Splitting them makes the cleanup durable before the index
-- creation is ever attempted.
--
-- Any database that already has duplicate PENDING invites for the same
-- (org_id, email) — which this deployment's own dev stack turned out to
-- have, accumulated over normal test/demo use before this fix existed —
-- would fail to create that index (UniqueViolationError) without this
-- cleanup: keep only the most-recently-created pending invite per pair,
-- superseding the rest.
--
-- ROW_NUMBER() with an `id` tiebreaker (not a DISTINCT ON/NOT IN form)
-- because created_at alone is not unique enough to guarantee a single
-- survivor per (org_id, email) when rows share a timestamp — bulk invite
-- creation and low-resolution clocks both produce exact ties, and a
-- non-deterministic "pick one" can leave more than one row ranked first.
-- NULL org_id or email rows are left alone: Postgres unique indexes treat
-- NULLs as distinct from one another, so they can never violate that
-- constraint and must not be superseded.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY org_id, email
               ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM invites
    WHERE status = 'pending'
      AND org_id IS NOT NULL
      AND email IS NOT NULL
)
UPDATE invites SET status = 'superseded'
WHERE status = 'pending'
  AND id IN (SELECT id FROM ranked WHERE rn > 1);
