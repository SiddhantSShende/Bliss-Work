-- 0015_invite_pending_uniqueness.sql
--
-- Backstops create_invite_tx's invalidate-prior-pending-invite-on-mint fix
-- (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 6) against two genuinely
-- concurrent creates for the same (org_id, email): under READ COMMITTED,
-- transaction B's `UPDATE ... WHERE status='pending'` cannot see transaction
-- A's not-yet-committed INSERT, so both would otherwise supersede whatever
-- was already pending before either started, then both insert — leaving two
-- simultaneously-pending invites for the same pair.
--
-- With this partial unique index in place, the second concurrent INSERT
-- raises a unique-violation instead; the application catches that specific
-- error and retries the supersede-then-insert sequence once, now correctly
-- seeing the first invite as pending and superseding it.
--
-- Partial (WHERE status = 'pending') rather than a plain unique constraint
-- on (org_id, email): an org re-inviting the same address after a prior
-- invite was accepted/superseded/expired must not collide with that
-- historical row — only ever at most one row may be `pending` for a given
-- pair, and every other status is unrestricted.
--
-- Any database that already has the bug this migration prevents going
-- forward — duplicate PENDING invites for the same (org_id, email), which
-- this deployment's own dev stack turned out to have, accumulated over
-- normal test/demo use before this fix existed — fails to create the index
-- at all (UniqueViolationError) without this cleanup: keep only the
-- most-recently-created pending invite per pair, superseding the rest.
UPDATE invites SET status = 'superseded'
WHERE status = 'pending'
  AND id NOT IN (
      SELECT DISTINCT ON (org_id, email) id
      FROM invites
      WHERE status = 'pending'
      ORDER BY org_id, email, created_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_org_email_pending
    ON invites (org_id, email)
    WHERE status = 'pending';
