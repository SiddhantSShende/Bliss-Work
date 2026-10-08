-- Scope create-task idempotency to the actor and bind each key to its request.
-- Existing task rows provide the original actor; legacy fingerprints remain
-- NULL and are rejected on replay because equivalence cannot be established.
SELECT set_config('app.bypass_rls', 'on', true);

ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS sender_id uuid;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_fingerprint text;

UPDATE idempotency_keys AS keys
SET sender_id = tasks.sender_id
FROM tasks
WHERE tasks.id = keys.task_id
  AND keys.sender_id IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM idempotency_keys WHERE sender_id IS NULL) THEN
        RAISE EXCEPTION
            'cannot scope legacy idempotency keys: one or more task rows are missing';
    END IF;
END $$;

ALTER TABLE idempotency_keys ALTER COLUMN sender_id SET NOT NULL;
ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
ALTER TABLE idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (org_id, sender_id, key);
