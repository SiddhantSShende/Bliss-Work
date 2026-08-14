-- Organization deletion: request, grace period, cancel, purge.
--
-- WHY THIS IS NOT "delete the org when the last member is removed"
-- ----------------------------------------------------------------
-- That state is unreachable by construction and deliberately so:
-- `members.py::_reject_self` stops an admin acting on their own account, and
-- `members_service.py::would_orphan_org` refuses any change that would leave
-- the org with zero active admins. Reaching "no members left" therefore means
-- deleting the invariant that keeps an org administerable, in order to make an
-- IRREVERSIBLE action fire from a REVERSIBLE one — removal is a soft revoke
-- that reactivation undoes. It would also be a denial-of-service primitive: one
-- compromised admin account could destroy a workspace's entire history with no
-- second party and no delay.
--
-- So destruction is explicit, confirmed, delayed, and cancellable. The
-- "everyone is gone" case is still DETECTED (an `org.orphaned` audit entry),
-- it just does not act.
--
-- Idempotent, like every migration here — this file re-runs on every startup.

-- ── Lifecycle columns on orgs ────────────────────────────────────────────────
-- Deliberately four columns rather than one status enum: "when was it asked
-- for", "by whom", "when does it become irreversible" and "when did it actually
-- happen" are four separate questions, and every one of them gets asked during
-- an incident.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS delete_requested_at timestamptz;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS delete_requested_by uuid;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS purge_after         timestamptz;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS deleted_at          timestamptz;

-- The purge job's only query: orgs whose grace period has elapsed and which
-- have not already been purged. Partial, because in a healthy system this
-- matches nothing and a full index would be almost entirely dead weight.
CREATE INDEX IF NOT EXISTS idx_orgs_purge_due
    ON orgs (purge_after)
    WHERE deleted_at IS NULL AND purge_after IS NOT NULL;

-- ── Tombstones ───────────────────────────────────────────────────────────────
-- NEVER purged, and that is the point.
--
-- `audit_log` is hash-chained and lives INSIDE the org's own RLS-scoped data,
-- so purging an org destroys its own record of having been destroyed. Without
-- something outside that boundary, the only honest answer to "what happened to
-- org X?" after a purge would be silence — indistinguishable from a bug, a
-- restore gone wrong, or an org that never existed.
--
-- Holds no personal data: an id, the slug (already public, and what a support
-- ticket will quote), the requesting user's id, and two timestamps.
CREATE TABLE IF NOT EXISTS deleted_orgs (
    org_id       uuid PRIMARY KEY,
    slug         text,
    requested_by uuid,
    requested_at timestamptz,
    purged_at    timestamptz NOT NULL DEFAULT now()
);
