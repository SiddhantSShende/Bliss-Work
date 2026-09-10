package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// orgPurgeTables are deleted by a plain `WHERE org_id = $1`, in this order.
//
// Children before parents. Nothing here has ON DELETE CASCADE, so the order is
// the only thing keeping a delete from failing on a dangling reference — and a
// failure mid-purge leaves an org half-erased, which is worse than either
// outcome. Append new org-scoped tables to the position that respects their
// references, not to the end.
var orgPurgeTables = []string{
	// Message-level children.
	"message_reactions",
	"message_hides",
	// Holds a third party's phone number in plaintext (and their name under the
	// org DEK), so it must be erased outright rather than left to the
	// crypto-shred that covers encrypted columns.
	"message_forwards",
	"messages",
	// Mail. Recipients and deliveries cascade off mail_messages, but they are
	// listed explicitly and first: a purge that relies on a cascade is a purge
	// that silently stops working the day someone drops the foreign key.
	"mail_recipients",
	"mail_deliveries",
	"mail_messages",
	// Inbox and threads.
	"inbox_items",
	"thread_members",
	"threads",
	// Conversations.
	"conversation_members",
	"conversations",
	// Channels.
	"channel_messages",
	"channel_members",
	"channel_member_history",
	"channel_blocks",
	"channels",
	// Calls. call_participants is handled separately, above the main loop,
	// because its org_id is the PARTICIPANT's own org rather than the call's
	// hosting org (see 0015_calls.sql) — a plain `WHERE org_id = $1` here
	// would miss a cross-org guest's row in one of THIS org's calls. The other
	// four all carry the hosting org (call_recordings/call_invites/
	// call_screenshares/call_chat_messages/call_notes' own doc comments say so
	// explicitly), so a plain org-scoped delete is correct for them.
	// call_recordings, call_chat_messages and call_notes all have an actual
	// `ON DELETE CASCADE` off calls (0029_call_transcript.sql for the latter
	// two), but are still listed explicitly per this file's own rule: a purge
	// that relies on a cascade is a purge that silently stops working the day
	// someone drops the foreign key.
	"call_recordings",
	"call_invites",
	"call_screenshares",
	"call_chat_messages",
	"call_notes",
	"calls",
	// Attachment ROWS. The bytes on disk are removed separately by
	// blob.Store.RemoveOrg — they are not in the database and, unlike every
	// encrypted column here, they are not covered by the crypto-shred either.
	"attachments",
	"user_projection",
	// Last. Once this is gone the org's *_enc columns are unreadable, so
	// dropping it before the rows above would only make a partial failure
	// harder to reason about.
	"org_keys",
}

// purgeBatchSize bounds how many rows a single DELETE inside PurgeOrg removes.
//
// Before this, PurgeOrg ran as one transaction spanning roughly 30 tables. For
// a large org that is a long-running transaction holding locks across every
// one of them — a timeout or lock contention partway through forced a full
// retry from scratch, of a transaction that only gets bigger as the org does.
// Batching means a stall loses at most one batch's worth of work, and (per
// PurgeOrg's own doc comment) a redelivered `org.deleted` simply picks up
// wherever the last one left off, since every batch's WHERE clause matches
// only rows that are still there.
const purgeBatchSize = 2000

// purgeInBatches deletes every row matching whereSQL from table, in bounded
// batches of purgeBatchSize, each batch committed as its OWN transaction
// rather than one giant one. Returns the total rows removed.
//
// ctid — Postgres's internal physical row locator — is what lets this work
// uniformly across every table PurgeOrg touches. Several of them
// (channel_members, message_reactions, mail_recipients, call_participants, …)
// have composite primary keys rather than a single `id` column, so a generic
// "delete up to N matching rows" cannot name a batch by primary key without
// knowing each table's key shape. ctid needs no such knowledge, and is stable
// for the lifetime of the single DELETE that reads then removes it.
func (s *Store) purgeInBatches(ctx context.Context, table, whereSQL string, args ...any) (int64, error) {
	// Table names are always one of the fixed strings PurgeOrg passes below,
	// never derived from input.
	query := fmt.Sprintf(
		`DELETE FROM %s WHERE ctid IN (SELECT ctid FROM %s WHERE %s LIMIT %d)`,
		table, table, whereSQL, purgeBatchSize)
	var total int64
	for {
		var n int64
		err := s.withBypass(ctx, func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, query, args...)
			if err != nil {
				return err
			}
			n = tag.RowsAffected()
			return nil
		})
		if err != nil {
			return total, err
		}
		total += n
		if n < purgeBatchSize {
			return total, nil
		}
	}
}

// PurgeOrg deletes every row belonging to one organization.
//
// Driven by `org.deleted` from auth-svc. Idempotent — the event can be
// redelivered after a consumer-group rebalance, and running this over an org
// that is already gone deletes nothing and reports success.
//
// Runs under bypass RLS: this is a trusted background worker acting on an org
// it was told about rather than one derived from a request, so there is no
// request org to scope to and every delete would otherwise match zero rows.
//
// Each table is purged in bounded batches (purgeInBatches) rather than as one
// unbounded statement inside one unbounded transaction — see purgeBatchSize's
// comment. Table order is preserved exactly: message_delivery and
// call_participants still run before the main loop and before `messages`/
// `calls` are dropped, for the FK-shaped reasons their own comments below
// give, and orgPurgeTables' children-before-parents ordering is untouched.
func (s *Store) PurgeOrg(ctx context.Context, orgID string) (map[string]int64, error) {
	deleted := make(map[string]int64)

	// message_delivery carries no org_id and has no foreign key, so it can
	// only be reached THROUGH the org's messages. It must therefore go first:
	// once `messages` is deleted the ids are gone and these rows would be
	// orphaned forever, invisible to any org-scoped query.
	n, err := s.purgeInBatches(ctx, "message_delivery",
		"message_id IN (SELECT id FROM messages WHERE org_id = $1)", orgID)
	if err != nil {
		return nil, fmt.Errorf("purge message_delivery: %w", err)
	}
	if n > 0 {
		deleted["message_delivery"] = n
	}

	// call_participants: same reasoning as message_delivery above, and for
	// the same underlying reason — org_id here is the PARTICIPANT's own
	// org, so a purged org's OWN users' rows (in ANY org's call) need the
	// plain filter, while a cross-org GUEST's row in one of THIS org's
	// calls needs the subquery instead; a row can only ever match one of
	// the two. Must run before `calls` is dropped in the main loop below —
	// the subquery needs it to still exist.
	n, err = s.purgeInBatches(ctx, "call_participants",
		"org_id = $1 OR call_id IN (SELECT id FROM calls WHERE org_id = $1)", orgID)
	if err != nil {
		return nil, fmt.Errorf("purge call_participants: %w", err)
	}
	if n > 0 {
		deleted["call_participants"] = n
	}

	for _, table := range orgPurgeTables {
		// Table names come from the fixed slice above, never from input.
		n, err := s.purgeInBatches(ctx, table, "org_id = $1", orgID)
		if err != nil {
			return nil, fmt.Errorf("purge %s: %w", table, err)
		}
		if n > 0 {
			deleted[table] = n
		}
	}
	return deleted, nil
}
