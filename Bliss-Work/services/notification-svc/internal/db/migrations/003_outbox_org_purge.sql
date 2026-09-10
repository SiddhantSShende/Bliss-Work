-- 003_outbox_org_purge.sql — let org purge actually reach the outbox.
--
-- purgeOrg (internal/consumer/consumer.go) deletes an org's rows from
-- `notifications` on org.deleted, but `outbox` carries no org_id at all — so
-- any not-yet-published outbox row for that org survived every purge
-- untouched, and got published to notification.events.v1 after the org was
-- supposedly gone. This column, populated at Enqueue time, is what lets
-- purgeOrg reach those rows too.
--
-- Backfilled from the JSON payload's own orgId for rows already in flight —
-- every event type ever enqueued here (NotificationCreated, NotificationRead)
-- carries one — so the new column is usable immediately, not just for rows
-- written after this migration.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS org_id uuid;

UPDATE outbox
   SET org_id = (payload ->> 'orgId')::uuid
 WHERE org_id IS NULL
   AND payload ->> 'orgId' IS NOT NULL;

-- Partial + matching the claim index's own predicate: purgeOrg only ever
-- needs unpublished rows for one org, and this is the index that query scans.
CREATE INDEX IF NOT EXISTS idx_outbox_org_unpublished
    ON outbox (org_id)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;
