-- Member lifecycle: suspend (reversible) and remove-from-org.
--
-- `users.status` has existed since 0001_init with a default of 'active' but
-- nothing ever wrote another value. The member-admin endpoints now write
-- 'suspended' and 'removed'; this migration adds the timestamp that records
-- WHEN the membership was revoked, plus the index the (now status-filtered)
-- directory listing reads.
--
-- Deliberately NOT a CHECK constraint on `status`: a future state (e.g.
-- 'invited') would then require a lock-taking ALTER on a live table, and the
-- writers are the three service functions in routes/members_service.py.
--
-- Idempotent, like every migration here — this file re-runs on every startup.

ALTER TABLE users ADD COLUMN IF NOT EXISTS removed_at timestamptz;

-- Directory and member listings both filter on (org_id, status). The existing
-- indexes are the two UNIQUE (org_id, email/username) pairs, neither of which
-- can serve a status filter.
CREATE INDEX IF NOT EXISTS idx_users_org_status ON users (org_id, status);

-- audit_log is read by GET /auth/audit newest-first, keyset-paginated on id.
-- 0004_audit_chain added idx_audit_log_org_chain (org_id, id) for the hash-chain
-- walk, which serves this too — no extra index needed.
