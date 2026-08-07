package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// MarkDelivered stamps message_delivery.delivered_at for the (messageId, recipientId)
// pair and emits a MessageDelivered event through the outbox. Idempotent —
// the second call for the same pair is a no-op (no new event emitted).
//
// Called by the Phase 5 internal HTTP endpoint that ws-gateway POSTs after
// it forwards bytes for a MessageCreated to the recipient's live socket.
func (s *Store) MarkDelivered(ctx context.Context, recipientID string, messageIDs []string) error {
	if len(messageIDs) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: this is a trusted internal service-to-service path (ws-gateway delivery
	// ack) with NO caller org in scope — the org is resolved FROM each message.
	// BYPASS lets the cross-message lookup span whatever org each message lives in.
	if err := setBypassGUC(ctx, tx); err != nil {
		return err
	}

	for _, mid := range messageIDs {
		var orgID, convID, senderID string
		var threadID *string
		err = tx.QueryRow(ctx, `
			SELECT org_id, conversation_id, sender_id, thread_id
			FROM messages WHERE id = $1`, mid).
			Scan(&orgID, &convID, &senderID, &threadID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Unknown messageId — skip, no event.
			continue
		}
		if err != nil {
			return err
		}
		// Self-delivery (sender is recipient): no-op.
		if senderID == recipientID {
			continue
		}

		// Try to claim the delivered_at slot. ON CONFLICT … WHERE
		// delivered_at IS NULL ensures only the first ack emits the event.
		ct, dberr := tx.Exec(ctx, `
			INSERT INTO message_delivery (message_id, recipient_id, delivered_at)
			VALUES ($1, $2, now())
			ON CONFLICT (message_id, recipient_id)
			DO UPDATE SET delivered_at = COALESCE(message_delivery.delivered_at, now())
			WHERE message_delivery.delivered_at IS NULL`,
			mid, recipientID)
		if dberr != nil {
			return dberr
		}
		if ct.RowsAffected() == 0 {
			// Already delivered (recipient acked twice). Skip event emit.
			continue
		}

		evt := events.MessageDelivered{
			Type:           events.TypeMessageDelivered,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			ThreadID:       threadID,
			MessageID:      mid,
			SenderID:       senderID,
			RecipientID:    recipientID,
			DeliveredAt:    nowISO(),
		}
		if err := insertOutbox(ctx, tx, convID, evt); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// MarkRead advances the caller's last_read_seq and emits message.read.
// Also (new in Phase 1) zeros the caller's unread count for every thread in
// this conversation up through upToSeq and stamps message_delivery.read_at.
func (s *Store) MarkRead(ctx context.Context, orgID, callerID, convID string, upToSeq int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	var low, high, cOrg string
	err = tx.QueryRow(ctx,
		`SELECT org_id, user_low, user_high FROM conversations WHERE id = $1`, convID).
		Scan(&cOrg, &low, &high)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if callerID != low && callerID != high {
		return ErrForbidden
	}
	peer := high
	if callerID == high {
		peer = low
	}

	ct, err := tx.Exec(ctx,
		`UPDATE conversation_members SET last_read_seq = GREATEST(last_read_seq, $3)
		 WHERE conversation_id = $1 AND user_id = $2`, convID, callerID, upToSeq)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrForbidden
	}

	// Advance per-thread last_read_seq for every thread the caller is a
	// member of in this conversation, where the caller's seen frontier moved.
	if _, err = tx.Exec(ctx, `
		UPDATE thread_members tm
		SET last_read_seq = GREATEST(tm.last_read_seq, $3)
		FROM threads t
		WHERE tm.thread_id = t.id
		  AND tm.user_id = $2
		  AND t.conversation_id = $1`,
		convID, callerID, upToSeq); err != nil {
		return err
	}

	// Zero unread_count for every inbox_items THREAD row owned by the caller
	// in this conversation. Cheap — the partition is local.
	if _, err = tx.Exec(ctx, `
		UPDATE inbox_items i
		SET unread_count = 0, updated_at = now()
		FROM threads t
		WHERE i.owner_user_id = $2
		  AND i.item_kind = 'THREAD'
		  AND i.ref_id = t.id
		  AND t.conversation_id = $1`,
		convID, callerID); err != nil {
		return err
	}

	// Stamp delivery+read for every message in this conversation up through
	// upToSeq from the peer. INSERT … ON CONFLICT keeps the read_at fresh.
	if _, err = tx.Exec(ctx, `
		INSERT INTO message_delivery (message_id, recipient_id, delivered_at, read_at)
		SELECT m.id, $2, COALESCE(md.delivered_at, now()), now()
		FROM messages m
		LEFT JOIN message_delivery md
		  ON md.message_id = m.id AND md.recipient_id = $2
		WHERE m.conversation_id = $1 AND m.sender_id <> $2 AND m.seq <= $3
		ON CONFLICT (message_id, recipient_id)
		DO UPDATE SET
		    read_at      = COALESCE(message_delivery.read_at, EXCLUDED.read_at),
		    delivered_at = COALESCE(message_delivery.delivered_at, EXCLUDED.delivered_at)`,
		convID, callerID, upToSeq); err != nil {
		return err
	}

	evt := events.MessageRead{
		Type:           events.TypeMessageRead,
		EventID:        uuid.Must(uuid.NewV7()).String(),
		OrgID:          orgID,
		OccurredAt:     nowISO(),
		ConversationID: convID,
		ReaderID:       callerID,
		UpToSeq:        upToSeq,
		RecipientID:    peer,
	}
	if err := insertOutbox(ctx, tx, convID, evt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkReadThread is the thread-scoped variant called by POST /threads/{id}/read
// in Phase 3. It only touches the one thread's last_read_seq + the matching
// inbox_items row, then emits MessageRead with threadId set.
func (s *Store) MarkReadThread(ctx context.Context, orgID, callerID, threadID string, upToSeq int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	var convID, senderID, recipientID, tOrg string
	err = tx.QueryRow(ctx, `
		SELECT org_id, conversation_id, sender_id, recipient_id
		FROM threads WHERE id = $1`, threadID).
		Scan(&tOrg, &convID, &senderID, &recipientID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && tOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if callerID != senderID && callerID != recipientID {
		return ErrForbidden
	}
	peer := senderID
	if callerID == senderID {
		peer = recipientID
	}

	if _, err = tx.Exec(ctx, `
		UPDATE thread_members
		SET last_read_seq = GREATEST(last_read_seq, $3)
		WHERE thread_id = $1 AND user_id = $2`,
		threadID, callerID, upToSeq); err != nil {
		return err
	}

	if err := ClearThreadUnread(ctx, tx, callerID, threadID); err != nil {
		return err
	}

	// Stamp message_delivery rows for messages from peer up to upToSeq.
	if _, err = tx.Exec(ctx, `
		INSERT INTO message_delivery (message_id, recipient_id, delivered_at, read_at)
		SELECT m.id, $2, COALESCE(md.delivered_at, now()), now()
		FROM messages m
		LEFT JOIN message_delivery md
		  ON md.message_id = m.id AND md.recipient_id = $2
		WHERE m.thread_id = $1 AND m.sender_id <> $2 AND m.seq <= $3
		ON CONFLICT (message_id, recipient_id)
		DO UPDATE SET
		    read_at      = COALESCE(message_delivery.read_at, EXCLUDED.read_at),
		    delivered_at = COALESCE(message_delivery.delivered_at, EXCLUDED.delivered_at)`,
		threadID, callerID, upToSeq); err != nil {
		return err
	}

	evt := events.MessageRead{
		Type:           events.TypeMessageRead,
		EventID:        uuid.Must(uuid.NewV7()).String(),
		OrgID:          orgID,
		OccurredAt:     nowISO(),
		ConversationID: convID,
		ReaderID:       callerID,
		UpToSeq:        upToSeq,
		RecipientID:    peer,
		ThreadID:       &threadID,
	}
	if err := insertOutbox(ctx, tx, convID, evt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListMessages returns messages of a conversation ascending by seq. Caller must
// be a member. Now scans the wider tuple including thread/parent/root fields.
func (s *Store) ListMessages(ctx context.Context, orgID, callerID, convID string) ([]MessageDTO, error) {
	out := []MessageDTO{}
	// RLS: membership read, message read, and per-row decrypt all under app.org_id.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var low, high, cOrg string
		serr := tx.QueryRow(ctx,
			`SELECT org_id, user_low, user_high FROM conversations WHERE id = $1`, convID).
			Scan(&cOrg, &low, &high)
		if errors.Is(serr, pgx.ErrNoRows) || (serr == nil && cOrg != orgID) {
			return ErrForbidden
		}
		if serr != nil {
			return serr
		}
		if callerID != low && callerID != high {
			return ErrForbidden
		}

		rows, err := tx.Query(ctx, `
			SELECT id, conversation_id, thread_id, parent_message_id, is_thread_root,
			       seq, sender_id, body, body_enc, created_at, sender_dismissed_at, kind
			FROM messages
			WHERE conversation_id = $1
			  AND (sender_id <> $2 OR sender_dismissed_at IS NULL)
			ORDER BY seq ASC`, convID, callerID)
		if err != nil {
			return err
		}
		// Buffer raw rows, then close the cursor before decrypting on the tx.
		var raws []rawMessage
		for rows.Next() {
			r, scanErr := scanRawMessage(rows)
			if scanErr != nil {
				rows.Close()
				return scanErr
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range raws {
			m, derr := s.decryptMessage(ctx, tx, orgID, r)
			if derr != nil {
				return derr
			}
			out = append(out, m)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
