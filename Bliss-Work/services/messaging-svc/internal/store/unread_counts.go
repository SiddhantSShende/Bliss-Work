package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// UnreadCounts is the lightweight equivalent of summing ListConversations'/
// ListChannels'/ListInboxPeers' per-row `unread`/`unreadCount` fields — the
// same underlying subqueries, aggregated server-side instead of summed
// client-side over a full list fetch. Exists so a sidebar badge can show
// three numbers without downloading the full conversations/channels/
// inbox-peers lists first (see docs/API-LAZY-LOADING-AUDIT.md, section D1).
type UnreadCounts struct {
	Conversations int64 `json:"conversations"`
	Channels      int64 `json:"channels"`
	InboxPeers    int64 `json:"inboxPeers"`
}

// inboxBadgeKinds mirrors packages/app/src/lib/inboxKinds.ts's INBOX_KINDS
// exactly — the badge must count what the mail list actually shows, or it
// points at rows the user cannot find there. Fixed here (not a caller
// parameter) because this endpoint only ever answers the one question the
// sidebar badge asks.
var inboxBadgeKinds = []string{"MAIL", "THREAD"}

// UnreadCounts returns the caller's unread totals across conversations,
// channels, and mail/thread inbox items, in one round trip.
//
// RLS: runs inside withOrg so app.org_id is set for all three queries —
// same posture as ListConversations/ListChannels/ListInboxPeers, which this
// intentionally mirrors query-for-query rather than introducing a new way
// to compute "unread" that could drift from what the full lists show.
func (s *Store) UnreadCounts(ctx context.Context, orgID, userID string) (UnreadCounts, error) {
	var out UnreadCounts
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Identical subquery to ListConversations' per-row `unread`
		// (conversations.go), summed across every visible conversation
		// instead of returned per row.
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(
			    (SELECT count(*) FROM messages m2
			     WHERE m2.conversation_id = c.id
			       AND m2.sender_id <> $2
			       AND m2.seq > cm.last_read_seq
			       AND NOT EXISTS (
			           SELECT 1 FROM message_hides h
			           WHERE h.message_id = m2.id AND h.user_id = $2
			       ))
			), 0)
			FROM conversations c
			JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
			WHERE c.org_id = $1 AND cm.visible = true`,
			orgID, userID).Scan(&out.Conversations); err != nil {
			return err
		}

		// Identical subquery to ListChannels' per-row `unread`
		// (channels_read.go), summed across every one of the caller's
		// channels instead of returned per row.
		if err := tx.QueryRow(ctx, `
			WITH mine AS (
			    SELECT channel_id, last_read_seq FROM channel_members WHERE user_id = $2
			)
			SELECT COALESCE(SUM(
			    (SELECT count(*) FROM channel_messages m2
			     WHERE m2.channel_id = c.id
			       AND m2.sender_id <> $2
			       AND m2.seq > mine.last_read_seq)
			), 0)
			FROM channels c
			JOIN mine ON mine.channel_id = c.id
			WHERE c.org_id = $1`,
			orgID, userID).Scan(&out.Channels); err != nil {
			return err
		}

		// inbox_items already carries a per-(owner,peer) unread_count column
		// (see ListInboxPeers, inbox.go) — sum it directly under the same
		// filter that function uses, rather than grouping by peer and summing
		// client-side.
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(unread_count), 0)
			FROM inbox_items
			WHERE owner_user_id = $1 AND org_id = $2
			  AND NOT hidden_for_owner AND NOT deleted_for_owner
			  AND peer_user_id IS NOT NULL
			  AND item_kind = ANY($3::text[])`,
			userID, orgID, inboxBadgeKinds).Scan(&out.InboxPeers); err != nil {
			return err
		}
		return nil
	})
	return out, err
}
