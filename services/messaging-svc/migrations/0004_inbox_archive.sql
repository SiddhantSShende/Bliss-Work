-- 0004_inbox_archive.sql ─ Phase 11 cleanup support.
--
-- 90-day archive purge of hidden inbox rows. Operationally this migration ONLY
-- creates the SQL function `purge_inbox_archive()`; a separate cron job
-- (whatever scheduler the operator prefers — pg_cron, a kube CronJob, etc.)
-- actually invokes it nightly. The function is parameter-free so any caller
-- can invoke it idempotently.
--
-- Why a function not a migration body: re-running this file on every boot
-- should NOT delete inbox rows. Migrations are idempotent state transitions,
-- not data lifecycle jobs.

CREATE OR REPLACE FUNCTION purge_inbox_archive() RETURNS bigint AS $$
DECLARE
    n bigint;
BEGIN
    DELETE FROM inbox_items
    WHERE hidden_for_owner
      AND last_event_at < now() - interval '90 days';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;

-- A view operators can sanity-check before scheduling the cron — "how many
-- rows would be purged right now?". Cheap; uses the partial index on
-- inbox_items already in 0003.
CREATE OR REPLACE VIEW inbox_archive_candidates AS
SELECT count(*) AS row_count
FROM inbox_items
WHERE hidden_for_owner
  AND last_event_at < now() - interval '90 days';
