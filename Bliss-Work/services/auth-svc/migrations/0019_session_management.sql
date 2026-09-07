-- 0019: support GET/DELETE /auth/sessions (active-session listing + revoke).
--
-- No new tables or columns: a "session" is exactly the existing refresh-token
-- family (refresh_tokens.family_id), and its metadata (ip/user agent) already
-- lives in audit_log.meta, written by session_events.session_started /
-- org_switched (see routes/session_events.py, Phase 9). This migration adds
-- only the index the new lookup needs.
--
-- The new query is: "for this org, resolve N family ids (a user's own
-- sessions, at most a handful) to their login/switch audit row". Without an
-- index that is a full scan of audit_log filtered by org_id — a table that is
-- append-only and NEVER pruned (it's the tamper-evident chain), so it only
-- grows. idx_audit_log_org_chain (org_id, id) does not help here: it orders
-- for the chain walk, not for a `meta->>'sessionId'` match.
--
-- Partial + expression index: only the two action types that ever carry a
-- sessionId are indexed, keeping it small relative to the full audit_log.
CREATE INDEX IF NOT EXISTS idx_audit_log_session_lookup
    ON audit_log (org_id, (meta->>'sessionId'))
    WHERE action IN ('auth.login', 'auth.org_switched');
