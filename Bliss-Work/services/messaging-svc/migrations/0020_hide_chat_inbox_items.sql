-- 0020_hide_chat_inbox_items.sql — finish the job 0014 only claimed to do.
--
-- SYMPTOM: chat DMs appear in the Inbox. The Inbox is the email-style surface;
-- Chats is instant messaging, and a 1:1 chat has no business in either the
-- Inbox feed or the People sidebar's unread rollup.
--
-- 0014_message_features.sql already added `threads.origin` and stopped
-- appendMessage writing inbox_items rows for chat, which works: no chat row has
-- been created or hoisted since it was applied. It also carried a one-shot
-- backfill to hide the rows written BEFORE the distinction existed:
--
--     UPDATE inbox_items SET hidden_for_owner = true WHERE item_kind = 'THREAD';
--
-- That statement matched zero rows. `inbox_items` is ENABLE + *FORCE* ROW LEVEL
-- SECURITY (0007_rls.sql) and `messaging_user` holds neither SUPERUSER nor
-- BYPASSRLS, so the fail-closed org_isolation policy applied to the migration
-- itself — with `app.org_id` unset, every row was invisible to it. `UPDATE 0`
-- is a perfectly successful statement, so the migration committed, recorded
-- itself in schema_migrations, and created its own
-- `inbox_items_thread_backfill_done` marker, which guarantees it can never
-- retry. Meanwhile InboxFeed.tsx dropped the client-side item_kind='TASK'
-- filter that had been hiding these rows, on the strength of that backfill.
--
-- Net effect: every pre-0014 chat thread became visible in the Inbox at once,
-- carrying its stale unread count into the rail badge and People sidebar.
--
-- Store.Migrate now sets app.bypass_rls for the migration transaction, so this
-- class of silent no-op cannot recur. This file is the data repair.

DO $chat_inbox$
DECLARE
    hidden bigint;
BEGIN
    -- PRECONDITION, checked before the repair rather than after it.
    --
    -- A post-hoc "did it work?" SELECT cannot answer this question: that SELECT
    -- is filtered by the very policy that would have suppressed the UPDATE, so
    -- with RLS active it counts zero remaining rows and cheerfully reports
    -- success. The first draft of this file made exactly that mistake. The only
    -- honest check is whether the bypass is in force at all, which is a GUC
    -- read and therefore immune to row filtering.
    --
    -- EXCEPTION, not WARNING: a repair that cannot touch a row must not be
    -- allowed to commit and be recorded as applied. Failing here aborts the
    -- migration transaction and the service retries on the next boot, which is
    -- strictly better than the silent success that caused this bug.
    IF COALESCE(current_setting('app.bypass_rls', true), '') <> 'on' THEN
        RAISE EXCEPTION
            '0020 needs app.bypass_rls=on: inbox_items is FORCE RLS and this '
            'role is not SUPERUSER/BYPASSRLS, so the UPDATE below would match '
            'zero rows and commit as a no-op (see Store.Migrate)';
    END IF;

    -- Hide, do not delete — the same reversible choice 0014 made.
    -- `hidden_for_owner` is the existing "not in my inbox" flag; nothing here is
    -- destructive and a single UPDATE puts any row back.
    --
    -- Scoped by thread ORIGIN rather than blanket item_kind='THREAD', which is
    -- what 0014 could not do at the moment its own statement ran. Mail threads
    -- are the Inbox's entire reason to show THREAD rows, and Compose has been
    -- writing real ones since 0014 — a blanket hide would now take those too.
    --
    -- `NOT hidden_for_owner` keeps this idempotent and, more importantly, keeps
    -- a re-run from re-hiding a row somebody deliberately revived.
    UPDATE inbox_items i
    SET    hidden_for_owner = true,
           updated_at       = now()
    FROM   threads t
    WHERE  t.id = i.ref_id
      AND  i.item_kind = 'THREAD'
      AND  t.origin = 'chat'
      AND  NOT i.hidden_for_owner;

    GET DIAGNOSTICS hidden = ROW_COUNT;
    RAISE NOTICE '0020: hid % chat THREAD row(s) from the inbox', hidden;
END
$chat_inbox$;
