-- 005_drop_plaintext_task_cols.sql — finish the at-rest encryption rollout.
--
-- 003_column_encryption.sql added title_enc/description_enc and made the plaintext
-- tasks.title / tasks.description NULLABLE, but never dropped them. The app has
-- fully cut over to the *_enc columns (writes + reads), so the plaintext columns
-- are dead going forward — and any row created BEFORE 003 may still hold cleartext
-- PII at rest. This migration drops them.
--
-- SAFETY: it drops ONLY after asserting no plaintext remains; otherwise it raises
-- (so an operator runs scripts/backfill-task-plaintext.py first) rather than
-- destroying un-migrated cleartext.
--
-- IDEMPOTENT: re-runs are a no-op once the columns are gone (guarded on
-- information_schema; the row check uses dynamic SQL so it is never parsed after
-- the columns no longer exist).
--
-- RLS: tasks has FORCE row-level security, so the owner role is also subject to
-- the org policy. The count runs under app.bypass_rls so it sees EVERY org's rows
-- (without the bypass it would see 0 and pass vacuously). DROP COLUMN is DDL and
-- is unaffected by RLS.

DO $$
DECLARE
    n bigint;
    has_cols boolean;
BEGIN
    SELECT count(*) = 2 INTO has_cols
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'tasks'
       AND column_name IN ('title', 'description');

    IF NOT has_cols THEN
        RETURN;  -- already dropped — idempotent no-op
    END IF;

    -- Only NON-EMPTY plaintext counts as residual PII: post-003 rows never write
    -- these columns, so title stays NULL and description takes its DEFAULT '' —
    -- neither is real cleartext. Using length() avoids empty-string false trips
    -- (and quote-escaping inside this EXECUTE string).
    PERFORM set_config('app.bypass_rls', 'on', true);
    EXECUTE 'SELECT count(*) FROM tasks '
            'WHERE COALESCE(length(title), 0) > 0 OR COALESCE(length(description), 0) > 0'
        INTO n;

    IF n > 0 THEN
        RAISE EXCEPTION
            'refusing to drop plaintext task columns: % row(s) still have non-empty plaintext title/description — run scripts/backfill-task-plaintext.py first',
            n;
    END IF;

    EXECUTE 'ALTER TABLE tasks DROP COLUMN IF EXISTS title';
    EXECUTE 'ALTER TABLE tasks DROP COLUMN IF EXISTS description';
END $$;
