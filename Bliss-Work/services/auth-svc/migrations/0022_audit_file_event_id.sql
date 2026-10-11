-- 0022_audit_file_event_id — one audit row per file-access event, however often it
-- is delivered.
--
-- telemetry-svc reports every file open / download to auth-svc's hash-chained
-- audit_log (routes/internal_file_audit.py). Delivery is at-least-once: when the
-- call fails, telemetry fails the beacon and the client resends the same events,
-- so the same event id can arrive again. The writer checks for it under the
-- per-org audit lock; this index is what makes that check an index lookup rather
-- than a scan of an append-only table, and what makes a second row for one event
-- impossible rather than merely unlikely.
--
-- Partial, on the two file actions only: every other audit row (logins, role
-- changes, ...) has no eventId and must stay out of the index. Additive and
-- idempotent; it rewrites no row, so the hash chain is untouched.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_file_event
    ON audit_log (org_id, (meta ->> 'eventId'))
    WHERE action IN ('file.opened', 'file.downloaded');
