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

	// Read the caller's frontier BEFORE advancing it: the delivery stamp at the
	// bottom of this function only has to touch messages above it. FOR UPDATE
	// serialises concurrent MarkReads on the same membership, so two racing
	// calls cannot each compute a window from the same stale frontier.
	var prevReadSeq int64
	err = tx.QueryRow(ctx,
		`SELECT last_read_seq FROM conversation_members
		 WHERE conversation_id = $1 AND user_id = $2 FOR UPDATE`,
		convID, callerID).Scan(&prevReadSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}

	if _, err = tx.Exec(ctx,
		`UPDATE conversation_members SET last_read_seq = GREATEST(last_read_seq, $3)
		 WHERE conversation_id = $1 AND user_id = $2`,
		convID, callerID, upToSeq); err != nil {
		return err
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

	// Stamp delivery+read for peer messages in the half-open window
	// (prevReadSeq, upToSeq].
	//
	// The lower bound is what keeps this linear. Without it every read event —
	// and this fires on every message sent or received in an open chat, not
	// just on chat open — rewrote a row for every message ever sent in the
	// conversation, making total write work quadratic in message count and
	// leaving N dead tuples behind each pass for autovacuum to chase.
	//
	// Skipping everything at or below the old frontier is safe because MarkRead
	// and MarkReadThread are the only writers of read_at, and each stamps the
	// entire window it advances the frontier across.
	//
	// The ON CONFLICT guard covers the remaining overlap: a message already
	// delivered (receipts.go MarkDelivered stamps delivered_at independently)
	// but not yet read still needs its read_at, while a row that is already
	// complete is left alone instead of being rewritten to the same values.
	if _, err = tx.Exec(ctx, `
		INSERT INTO message_delivery (message_id, recipient_id, delivered_at, read_at)
		SELECT m.id, $2, COALESCE(md.delivered_at, now()), now()
		FROM messages m
		LEFT JOIN message_delivery md
		  ON md.message_id = m.id AND md.recipient_id = $2
		WHERE m.conversation_id = $1 AND m.sender_id <> $2
		  AND m.seq > $4 AND m.seq <= $3
		ON CONFLICT (message_id, recipient_id)
		DO UPDATE SET
		    read_at      = COALESCE(message_delivery.read_at, EXCLUDED.read_at),
		    delivered_at = COALESCE(message_delivery.delivered_at, EXCLUDED.delivered_at)
		WHERE message_delivery.read_at IS NULL
		   OR message_delivery.delivered_at IS NULL`,
		convID, callerID, upToSeq, prevReadSeq); err != nil {
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

	// Frontier first, then advance — see the note in MarkRead. Same quadratic
	// write amplification, same fix, scoped to the thread's own frontier.
	var prevReadSeq int64
	err = tx.QueryRow(ctx, `
		SELECT last_read_seq FROM thread_members
		WHERE thread_id = $1 AND user_id = $2 FOR UPDATE`,
		threadID, callerID).Scan(&prevReadSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
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

	// Stamp message_delivery for peer messages in (prevReadSeq, upToSeq].
	if _, err = tx.Exec(ctx, `
		INSERT INTO message_delivery (message_id, recipient_id, delivered_at, read_at)
		SELECT m.id, $2, COALESCE(md.delivered_at, now()), now()
		FROM messages m
		LEFT JOIN message_delivery md
		  ON md.message_id = m.id AND md.recipient_id = $2
		WHERE m.thread_id = $1 AND m.sender_id <> $2
		  AND m.seq > $4 AND m.seq <= $3
		ON CONFLICT (message_id, recipient_id)
		DO UPDATE SET
		    read_at      = COALESCE(message_delivery.read_at, EXCLUDED.read_at),
		    delivered_at = COALESCE(message_delivery.delivered_at, EXCLUDED.delivered_at)
		WHERE message_delivery.read_at IS NULL
		   OR message_delivery.delivered_at IS NULL`,
		threadID, callerID, upToSeq, prevReadSeq); err != nil {
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

// Page sizes for the conversation and channel history endpoints.
//
// maxMessagePage is a HARD server-side ceiling, not a suggestion: limit arrives
// from the client, and a limit the client can raise without bound is the same
// unbounded read this pagination replaced.
const (
	defaultMessagePage = 50
	maxMessagePage     = 100
)

// clampMessagePage resolves a client-supplied limit to a safe page size.
func clampMessagePage(limit int) int {
	if limit <= 0 {
		return defaultMessagePage
	}
	if limit > maxMessagePage {
		return maxMessagePage
	}
	return limit
}

// Page sizes for the open-channel directory (Browse).
//
// A separate pair from the message ones because the population is different in
// kind. A message page is a slice of one conversation's history; a directory
// page is a slice of EVERY open channel in the organisation, which is bounded
// by how large the org is and by nothing else. The rows are also dearer than
// they look — each carries a LATERAL lookup of its last message and is then
// decrypted individually — so the ceiling is lower than a raw row count would
// suggest.
const (
	defaultChannelPage = 50
	maxChannelPage     = 200
)

// clampChannelPage resolves a client-supplied directory page size.
func clampChannelPage(limit int) int {
	if limit <= 0 {
		return defaultChannelPage
	}
	if limit > maxChannelPage {
		return maxChannelPage
	}
	return limit
}

// clampOffset floors a client-supplied offset at zero. There is deliberately no
// ceiling: a caller paging honestly through a large directory has a legitimately
// large offset, and the page size is what bounds the work either way.
func clampOffset(offset int) int {
	if offset < 0 {
		return 0
	}
	return offset
}

// beforeSeqOrNewest turns the "0 means newest" wire convention into a sentinel
// the keyset predicate can compare against directly. Matches ListThreadMessages.
func beforeSeqOrNewest(beforeSeq int64) int64 {
	if beforeSeq <= 0 {
		return 1<<62 - 1
	}
	return beforeSeq
}

// reverseRaw flips a DESC-ordered buffer into the ASC order callers render in.
func reverseRaw[T any](rows []T) {
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
}

// ListMessages returns one page of a conversation's messages, ascending by seq.
// Caller must be a member.
//
// beforeSeq is an exclusive upper bound (0 = start from the newest), so paging
// backwards through history is a keyset walk served by idx_messages_conv_seq
// rather than an OFFSET that re-reads everything it skips.
//
// This used to have no LIMIT and no cursor at all: opening any conversation
// fetched its ENTIRE history — every row heap-visited, every body AES-GCM
// decrypted one at a time, the whole set buffered into this slice and
// marshalled into a single response body, all while holding one of the pool's
// ten connections. A conversation was therefore a bomb with a timer set by how
// much its participants liked each other.
//
// The query orders DESC to let the index serve the LIMIT, then the page is
// reversed before decryption so the returned slice keeps its ascending contract.
func (s *Store) ListMessages(
	ctx context.Context, orgID, callerID, convID string,
	beforeSeq int64, limit int,
) ([]MessageDTO, error) {
	limit = clampMessagePage(limit)
	beforeSeq = beforeSeqOrNewest(beforeSeq)

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
			SELECT`+messageColumns+`
			FROM messages m`+messageDeliveryJoin+`
			WHERE m.conversation_id = $1 AND m.seq < $3
			  AND (m.sender_id <> $2 OR m.sender_dismissed_at IS NULL)
			  -- "Delete for me": one reader's decision, invisible to the other.
			  AND NOT EXISTS (
			      SELECT 1 FROM message_hides h
			      WHERE h.message_id = m.id AND h.user_id = $2
			  )
			ORDER BY m.seq DESC
			LIMIT $4`, convID, callerID, beforeSeq, limit)
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
		// Selected newest-first so the index could serve the LIMIT; callers and
		// the wire format both expect oldest-first.
		reverseRaw(raws)
		for _, r := range raws {
			m, derr := s.decryptMessage(ctx, tx, orgID, r)
			if derr != nil {
				return derr
			}
			// A delivery receipt is a fact about MY message reaching someone
			// else. On a message I received it is meaningless (and would render
			// as a checkmark on the wrong side of the thread).
			if m.SenderID != callerID {
				m.Status = ""
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
