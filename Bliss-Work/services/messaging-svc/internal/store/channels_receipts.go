// Per-member read receipts for channels.
//
// A DM asks "has the other person read this", and message_delivery answers it
// with one row per message because there is exactly one other person. A channel
// asks "which of these people has read this", and the answer is a cursor per
// member rather than a row per (message, member) — see 0028 for why the fan-out
// shape was not affordable.
//
// Everything here therefore works in `seq`: MarkChannelRead moves one member's
// cursor forward, and ChannelReadReceipts reads the cursors back and reports
// which of them have reached each message.
package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// ChannelReadReceiptDTO is one member's confirmation that they have seen one
// message. Mirrors the canonical ChannelReadReceiptDTO contract.
//
// `ReadAt` is the moment that member's cursor last moved, not the moment they
// looked at this particular message — a cursor cannot tell those apart. It is
// the closest honest answer, and it is always at or after the message was sent
// because a cursor only reaches a message by passing it.
type ChannelReadReceiptDTO struct {
	MessageID  string `json:"messageId"`
	ReaderID   string `json:"readerId"`
	ReaderName string `json:"readerName"`
	ReadAt     string `json:"readAt"`
}

// MarkChannelRead moves the caller's read cursor in one channel forward to
// upToSeq. The caller must be a member.
//
// GREATEST rather than an assignment: the cursor only ever moves forward, so
// two of somebody's tabs racing — one showing the newest page, one scrolled
// back — cannot pull it backwards and re-mark read messages as unread.
func (s *Store) MarkChannelRead(
	ctx context.Context, orgID, callerID, channelID string, upToSeq int64,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE channel_members
			SET last_read_seq = GREATEST(last_read_seq, $3),
			    last_read_at  = now()
			WHERE channel_id = $1 AND user_id = $2`,
			channelID, callerID, upToSeq)
		return err
	})
}

// ChannelReadReceipts answers, for each of `messageIDs`, which members have read
// that far. The caller must be a member of the channel.
//
// ── What is deliberately NOT reported ───────────────────────────────────────
// A message's own sender is excluded. "You have seen your own message" is not
// information, and including it would make every message read as seen by at
// least one person the moment it was sent.
//
// ── Why one query rather than one per message ───────────────────────────────
// The client asks about a whole page of messages at once, so a query per message
// would be N+1 on a channel's hottest read — the same trap reactionsFor records
// on the reaction side. The join does the whole page in one pass: every member
// whose cursor has reached a message pairs with that message.
func (s *Store) ChannelReadReceipts(
	ctx context.Context, orgID, callerID, channelID string, messageIDs []string,
) ([]ChannelReadReceiptDTO, error) {
	out := []ChannelReadReceiptDTO{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		// `m.channel_id = $1` is not redundant next to the id list: it is what
		// stops a caller passing message ids from a channel they are not in and
		// reading that channel's membership back out of the receipts.
		rows, err := tx.Query(ctx, `
			SELECT m.id, cm.user_id,
			       COALESCE(NULLIF(up.display_name, ''), up.username, ''),
			       cm.last_read_at
			FROM channel_messages m
			JOIN channel_members cm
			  ON cm.channel_id = m.channel_id
			 AND cm.last_read_seq >= m.seq
			 AND cm.user_id <> m.sender_id
			LEFT JOIN user_projection up ON up.user_id = cm.user_id
			WHERE m.channel_id = $1 AND m.id = ANY($2)
			ORDER BY m.id, cm.last_read_at DESC NULLS LAST`,
			channelID, messageIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r ChannelReadReceiptDTO
			// last_read_at is nullable for a membership that never read
			// anything — those rows cannot match the cursor join, but the
			// column is still scanned through a pointer rather than assumed.
			var readAt *time.Time
			if err := rows.Scan(&r.MessageID, &r.ReaderID, &r.ReaderName, &readAt); err != nil {
				return err
			}
			if readAt != nil {
				r.ReadAt = readAt.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
