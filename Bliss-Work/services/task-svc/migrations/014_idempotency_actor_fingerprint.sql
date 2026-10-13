-- Add actor and request metadata without breaking task-svc versions that still
-- insert only (org_id, key, task_id). Keep the legacy primary key throughout
-- the rollback window; relaxing it requires a later, separately coordinated
-- contract migration after every rollback image understands the new schema.
SELECT set_config('app.bypass_rls', 'on', true);

ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS sender_id uuid;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_fingerprint text;

-- Idempotency records are retained for one day (see app/jobs/prune_event_tables.py).
-- Only expired rows whose task has already been deleted are safe to discard:
-- they can no longer serve a retry, and deleting other keys would shorten the
-- documented retry window.
DELETE FROM idempotency_keys AS keys
WHERE keys.created_at < now() - interval '1 day'
  AND NOT EXISTS (
      SELECT 1
      FROM tasks
      WHERE tasks.id = keys.task_id
        AND tasks.org_id = keys.org_id
  );

UPDATE idempotency_keys AS keys
SET sender_id = tasks.sender_id
FROM tasks
WHERE tasks.id = keys.task_id
  AND tasks.org_id = keys.org_id
  AND keys.sender_id IS NULL;

DO $$
DECLARE
    orphaned_keys bigint;
BEGIN
    SELECT count(*)
    INTO orphaned_keys
    FROM idempotency_keys AS keys
    WHERE NOT EXISTS (
        SELECT 1
        FROM tasks
        WHERE tasks.id = keys.task_id
          AND tasks.org_id = keys.org_id
    );

    IF orphaned_keys > 0 THEN
        RAISE EXCEPTION
            'migration 014 blocked: % idempotency key(s) reference missing tasks and are still inside the one-day retry window; restore those task rows or obtain approval to remove the specific keys, then retry',
            orphaned_keys;
    END IF;
END $$;
