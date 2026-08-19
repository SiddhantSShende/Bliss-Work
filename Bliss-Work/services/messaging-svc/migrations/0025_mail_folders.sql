-- 0025_mail_folders.sql — Drafts and Deleted Items become real folders.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY
-- boot, so every statement guards re-execution.
--
-- Nothing structural changes here: both folders are listings over state that
-- already exists. What was missing was the ability to READ that state back, and
-- an index that makes each listing cheap.
--
-- ── Drafts ───────────────────────────────────────────────────────────────────
-- A draft has always been a real row (mail_messages.status = 'DRAFT'), created
-- when the composer opens so attachments have something to hang their
-- authorization off. It was simply never written to and never listed: the
-- composer discarded it on close, so nothing survived to show. Drafts now carry
-- their subject, body and addressees, which means the listing is ordered by the
-- moment the author last TOUCHED one — not by when the composer happened to
-- open. idx_mail_messages_drafts is on (author_user_id, created_at) and cannot
-- serve that order, so the folder gets its own index.
--
-- ── Deleted Items ────────────────────────────────────────────────────────────
-- Deleting a mail sets inbox_items.hidden_for_owner (see api/inbox.go): the row
-- is hidden from the feed, one-sidedly, and neither the mail nor anybody else's
-- copy is touched. So the deleted mailbox is that same feed read with the
-- predicate inverted — which the existing keyset index cannot serve, because it
-- is PARTIAL on `NOT hidden_for_owner` (0003_threads_inbox.sql) and therefore
-- contains none of the rows this folder lists.
--
-- Note for anyone reading the folder as permanent storage: purge_inbox_archive()
-- (0004_inbox_archive.sql) deletes hidden rows after 90 days. Deleted Items is a
-- 90-day recovery window, and the UI says so.

-- Drafts, most recently edited first — the order a Drafts folder is read in.
CREATE INDEX IF NOT EXISTS idx_mail_messages_drafts_recent
    ON mail_messages (author_user_id, updated_at DESC)
    WHERE status = 'DRAFT';

-- The Deleted Items keyset. Mirrors idx_inbox_items_owner_recency exactly,
-- inverted on hidden_for_owner. Declared on the parent so all 64 hash
-- partitions inherit it.
CREATE INDEX IF NOT EXISTS idx_inbox_items_owner_recency_hidden
    ON inbox_items (owner_user_id, last_event_at DESC, ref_id DESC)
    WHERE hidden_for_owner AND NOT deleted_for_owner;
