package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// Appending a channel message on a transaction the CALLER owns.
//
// SendChannelMessage (channels.go) is the ordinary path: it opens its own
// transaction, applies the membership and block gates, and commits. Both forward
// paths need the same insert to land atomically with work of their own — a
// provenance edge, and for an internal forward the re-scoped attachment rows —
// so they need a version that writes on a transaction they are still holding and
// leaves the commit to them.
//
// The gates are the CALLER's responsibility here, and both callers apply them
// (requireChannelMember + isBlocked) before reaching this.

// channelAppendOpts carries the optional columns a caller may set. The zero
// value is an ordinary text message, which is what an internal forward with no
// marker would be.
type channelAppendOpts struct {
	// kind is the channel_messages.kind value ("" → 'text'). System entries such
	// as the WhatsApp forward pill set it; it never comes from client input.
	kind string
	// messageID lets a caller mint the id BEFORE the insert, for when something
	// written earlier in the same transaction has to reference the row — the
	// provenance edge of a forward is exactly that. "" → generated here.
	messageID string
	// isForward marks the row as a delivered copy of someone else's message, so
	// the reader's client can label it rather than attributing the content to
	// whoever forwarded it.
	isForward     bool
	forwardedFrom string
}

func (o channelAppendOpts) kindArg() string {
	if o.kind == "" {
		return MessageKindText
	}
	return o.kind
}

// appendChannelMessageTx allocates a seq, inserts the message (idempotent on
// client_msg_id) and emits ChannelMessageCreated so every member's client
// renders it live. It does NOT commit.
func (s *Store) appendChannelMessageTx(
	ctx context.Context, tx pgx.Tx, orgID, channelID, senderID, body, clientMsgID string,
	opts channelAppendOpts,
) (string, error) {
	// Idempotency on the same (channel, sender, client_msg_id) key
	// SendChannelMessage uses, so a retried request re-uses the existing message
	// rather than stacking duplicates.
	var existingID string
	err := tx.QueryRow(ctx,
		`SELECT id FROM channel_messages
		 WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
		channelID, senderID, clientMsgID).Scan(&existingID)
	if err == nil {
		return existingID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	var seq int64
	if err := tx.QueryRow(ctx,
		`UPDATE channels SET seq_counter = seq_counter + 1, last_msg_at = now()
		 WHERE id = $1 RETURNING seq_counter`, channelID).Scan(&seq); err != nil {
		return "", err
	}
	bodyEnc, err := s.crypto.Encrypt(ctx, tx, orgID, body)
	if err != nil {
		return "", err
	}
	msgID := opts.messageID
	if msgID == "" {
		msgID = uuid.Must(uuid.NewV7()).String()
	}
	var forwardedFrom *string
	if opts.forwardedFrom != "" {
		forwardedFrom = &opts.forwardedFrom
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_messages
		   (id, org_id, channel_id, seq, sender_id, body, body_enc, client_msg_id, kind,
		    is_forward, forwarded_from_message_id)
		 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10)`,
		msgID, orgID, channelID, seq, senderID, bodyEnc, clientMsgID, opts.kindArg(),
		opts.isForward, forwardedFrom); err != nil {
		return "", err
	}

	members, err := channelMemberIDs(ctx, tx, channelID)
	if err != nil {
		return "", err
	}
	senderName, err := username(ctx, tx, senderID)
	if err != nil {
		return "", err
	}
	evt := events.ChannelMessageCreated{
		Type:           events.TypeChannelMessageCreated,
		EventID:        uuid.Must(uuid.NewV7()).String(),
		OrgID:          orgID,
		OccurredAt:     nowISO(),
		ChannelID:      channelID,
		MessageID:      msgID,
		Seq:            seq,
		SenderID:       senderID,
		SenderUsername: senderName,
		Body:           body,
		Members:        members,
		Kind:           opts.kind,
		IsForward:      opts.isForward,
	}
	if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
		return "", err
	}
	return msgID, nil
}
