package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// The write half of deep-link forwarding. Split from forward_link.go (which
// resolves and authorizes) only to keep both files inside the repo's 250-line
// limit; they are one feature and are meant to be read together.

// ForwardLinkRecord writes the provenance edge, the system entry in the origin
// chat, and the message.forwarded event — one transaction, so a client can never
// end up with a pill and no audit row (or the reverse).
//
// phone must already be normalized to bare E.164 digits and name sanitized; the
// API layer owns both (internal/api/phone.go).
func (s *Store) ForwardLinkRecord(
	ctx context.Context,
	orgID, forwarderID, sourceMessageID, phone, name, clientMsgID string,
	fc *ForwardSourceCtx,
) (*LinkForwardResult, error) {
	var out *LinkForwardResult
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		// Idempotency has to be checked HERE, not left to appendMessage. Its own
		// clientMsgId short-circuit happens after this function has already written
		// the message_forwards edge, so a retried request would leave a second edge
		// behind (and tell the author their message was forwarded twice). Keyed the
		// same way both write paths key their own dedupe, so a retry is a retry
		// whichever table the pill lives in.
		if existing, found, err := s.existingLinkPill(ctx, tx, fc, forwarderID, clientMsgID); err != nil {
			return err
		} else if found {
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			out = &LinkForwardResult{SystemMessageID: existing, TargetPhone: phone}
			return nil
		}

		// The contact's name is a third party's PII, so it goes under the org DEK
		// like every other name in the system (SECURITY.md §2). An empty name stays
		// NULL rather than encrypting the empty string.
		var nameEnc []byte
		if name != "" {
			nameEnc, err = s.crypto.Encrypt(ctx, tx, orgID, name)
			if err != nil {
				return err
			}
		}

		var channelArg *string
		if fc.Scope == scopeChannel {
			channelArg = &fc.ChannelID
		}

		// NULL, not "", when the recipient was chosen inside WhatsApp and never
		// reported back. An empty string would read as "we captured a number and it
		// was blank"; NULL says we never had one, which is the truth.
		var phoneArg *string
		if phone != "" {
			phoneArg = &phone
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO message_forwards
			   (id, org_id, root_message_id, root_author_id, parent_message_id,
			    forwarded_message_id, forwarded_by, forwarded_to, forwarded_to_external,
			    forwarded_to_name_enc, platform, delivery, channel_id, depth, path)
			 VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, $7, $8, 'whatsapp', 'unconfirmed',
			         $9, $10, $11::uuid[])`,
			uuid.Must(uuid.NewV7()).String(), orgID, fc.RootMessageID, fc.RootAuthorID,
			sourceMessageID, forwarderID, phoneArg, nameEnc, channelArg, fc.Depth, fc.Path); err != nil {
			return err
		}

		evt := events.MessageForwarded{
			Type:                events.TypeMessageForwarded,
			EventID:             uuid.Must(uuid.NewV7()).String(),
			OrgID:               orgID,
			OccurredAt:          nowISO(),
			ConversationID:      fc.ConversationID,
			ChannelID:           fc.ChannelID,
			RootMessageID:       fc.RootMessageID,
			RootAuthorID:        fc.RootAuthorID,
			ParentMessageID:     sourceMessageID,
			ForwardedBy:         forwarderID,
			ForwardedToExternal: phone,
			ForwardedToName:     name,
			Platform:            PlatformWhatsApp,
			Delivery:            "unconfirmed",
			Depth:               fc.Depth,
			BodyPreview:         truncatePreview(fc.Body),
		}
		// Kafka key: conversation for a DM, channel for a channel — the same
		// partitioning key the corresponding *MessageCreated used, so provenance
		// cannot overtake the entry it describes.
		key := fc.ConversationID
		if fc.Scope == scopeChannel {
			key = fc.ChannelID
		}
		if err := insertOutbox(ctx, tx, key, evt); err != nil {
			return err
		}

		// The system entry is written LAST because appendMessage owns the COMMIT of
		// the transaction it is handed (see messages.go) — nothing may be written on
		// this tx after it returns. Everything above is therefore already staged, and
		// the whole set lands or none of it does.
		pill := linkPillDetail(fc.Scope, name, phone)
		if fc.Scope == scopeChannel {
			systemMessageID, err := s.appendChannelMessageTx(ctx, tx, orgID, fc.ChannelID,
				forwarderID, pill, clientMsgID,
				channelAppendOpts{kind: MessageKindForwardExternal, forwardPlatform: PlatformWhatsApp})
			if err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			out = &LinkForwardResult{SystemMessageID: systemMessageID, TargetPhone: phone}
			return nil
		}

		// appendMessage gives the pill a seq, encryption, thread resolution, the
		// inbox projection and its own MessageCreated — so it persists, syncs to a
		// reconnecting client and appears in history like any other message. It
		// commits; do not commit again here.
		res, err := s.appendMessage(ctx, tx, orgID, fc.ConversationID, forwarderID, fc.OtherUserID,
			pill, clientMsgID, "", fc.ThreadID,
			appendOpts{kind: MessageKindForwardExternal, forwardPlatform: PlatformWhatsApp})
		if err != nil {
			return err
		}
		out = &LinkForwardResult{SystemMessageID: res.MessageID, TargetPhone: phone}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// existingLinkPill reports whether this exact request has already been recorded,
// by looking for the system entry a previous attempt would have written. Both
// message tables carry the same (scope, sender, client_msg_id) uniqueness, so the
// lookup is the same question asked of whichever one applies.
func (s *Store) existingLinkPill(
	ctx context.Context, tx pgx.Tx, fc *ForwardSourceCtx, forwarderID, clientMsgID string,
) (string, bool, error) {
	var (
		id  string
		err error
	)
	if fc.Scope == scopeChannel {
		err = tx.QueryRow(ctx,
			`SELECT id::text FROM channel_messages
			  WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
			fc.ChannelID, forwarderID, clientMsgID).Scan(&id)
	} else {
		err = tx.QueryRow(ctx,
			`SELECT id::text FROM messages
			  WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
			fc.ConversationID, forwarderID, clientMsgID).Scan(&id)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}
