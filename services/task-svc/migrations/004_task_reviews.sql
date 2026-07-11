-- 004_task_reviews.sql — allocator reviews on a completed assignment.
--
-- Idempotent (safe to run on every boot). The review is written by the task
-- SENDER (allocator) after an assignee reaches COMPLETED. Review free-text is
-- PII, so it is encrypted at rest under the org DEK exactly like title/description
-- (see 003_column_encryption.sql) — the column is `review_enc bytea`. The
-- optional 1..5 star rating and the reviewed_at timestamp are non-sensitive.
--
-- task_assignees already carries the `org_isolation` RLS policy (003_rls.sql);
-- new columns on that table inherit it — no new policy or index is needed
-- (reviews are read by the (task_id, assignee_id) primary key).

ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS review_enc    bytea;
ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS review_rating smallint;
ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz;

-- Guard the rating to the 1..5 range (NULL allowed — rating is optional).
DO $$ BEGIN
    ALTER TABLE task_assignees
        ADD CONSTRAINT task_assignees_review_rating_chk
        CHECK (review_rating IS NULL OR review_rating BETWEEN 1 AND 5);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
