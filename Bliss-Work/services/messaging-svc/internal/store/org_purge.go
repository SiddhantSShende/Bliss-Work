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

// PurgeOrg deletes every row belonging to one organization.
//
// Driven by `org.deleted` from auth-svc. Idempotent — the event can be
// redelivered after a consumer-group rebalance, and running this over an org
// that is already gone deletes nothing and reports success.
//
// Runs under bypass RLS: this is a trusted background worker acting on an org
// it was told about rather than one derived from a request, so there is no
// request org to scope to and every delete would otherwise match zero rows.
func (s *Store) PurgeOrg(ctx context.Context, orgID string) (map[string]int64, error) {
	deleted := make(map[string]int64)
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// message_delivery carries no org_id and has no foreign key, so it can
		// only be reached THROUGH the org's messages. It must therefore go
		// first: once `messages` is deleted the ids are gone and these rows
		// would be orphaned forever, invisible to any org-scoped query.
		tag, err := tx.Exec(ctx,
			`DELETE FROM message_delivery
			  WHERE message_id IN (SELECT id FROM messages WHERE org_id = $1)`, orgID)
		if err != nil {
			return fmt.Errorf("purge message_delivery: %w", err)
		}
		if n := tag.RowsAffected(); n > 0 {
			deleted["message_delivery"] = n
		}

		for _, table := range orgPurgeTables {
			// Table names come from the fixed slice above, never from input.
			tag, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE org_id = $1`, orgID)
			if err != nil {
				return fmt.Errorf("purge %s: %w", table, err)
			}
			if n := tag.RowsAffected(); n > 0 {
				deleted[table] = n
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return deleted, nil
}
