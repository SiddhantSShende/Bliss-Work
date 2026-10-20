-- 019_task_comments — task-specific, text-only threaded comments.
--
-- Separate from Chat (messaging-svc's task_discussions, the task-linked
-- DM/channel conversation a task's Chat button opens): comments are a
-- persistent, task-scoped discussion thread, visible only to the task's
-- sender and its current assignees (the same "who can see this task" rule
-- tasks_read.py already applies via task_assignees).
--
-- Thread depth is deliberately two levels: a top-level comment
-- (parent_comment_id IS NULL) and its replies (parent_comment_id -> a
-- top-level comment). Application code (routes/tasks_comments.py) enforces
-- that a reply's parent is itself top-level, so the tree can never grow
-- deeper — no unbounded recursive rendering, no unbounded query depth.
--
-- Content is encrypted at rest under the org DEK, same convention as
-- tasks.title_enc / description_enc (003_column_encryption.sql) and
-- task_assignees.review_enc (004_task_reviews.sql) — comment text is exactly
-- the kind of user content those already cover.

CREATE TABLE IF NOT EXISTS task_comments (
    id                uuid PRIMARY KEY,
    org_id            uuid NOT NULL,
    task_id           uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_comment_id uuid REFERENCES task_comments(id) ON DELETE CASCADE,
    author_id         uuid NOT NULL,
    body_enc          bytea NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Top-level comments for a task, newest-first keyset pagination:
-- ORDER BY created_at DESC, id DESC with a `(created_at, id) < (cursor)` predicate.
CREATE INDEX IF NOT EXISTS idx_task_comments_task_top_level
    ON task_comments (task_id, created_at DESC, id DESC)
    WHERE parent_comment_id IS NULL;

-- Replies to one top-level comment, oldest-first keyset pagination (natural
-- reading order within a thread).
CREATE INDEX IF NOT EXISTS idx_task_comments_parent
    ON task_comments (parent_comment_id, created_at ASC, id ASC)
    WHERE parent_comment_id IS NOT NULL;

SELECT apply_org_isolation('task_comments');
