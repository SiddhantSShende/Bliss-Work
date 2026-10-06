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
//
// ── Why this is batched, not a loop ──────────────────────────────────────────
// internal_delivery.go caps messageIds at 256 per call — the same number
// ws-gateway uses for its outbound flushes — so this is deliberately built for
// large batches. It used to run one SELECT, one conditional membership query,
// and one INSERT per id, sequentially, inside a retry loop that replayed the
// WHOLE batch on any serialization conflict: worst case, several hundred
// sequential round trips for one ack call. appendCallsTx (calls.go) already
// solved the identical shape of problem for paging calls — batch the reads
// with `= ANY($1)`, resolve membership once per distinct conversation/thread
// rather than once per message, and stitch the results together in memory.
func (s *Store) MarkDelivered(ctx context.Context, recipientID string, messageIDs []string) error {
	if len(messageIDs) == 0 {
		return nil
	}
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
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

		// 1. Every message in the ask, in one round trip. Unknown ids are simply
		// absent from the result — the same "skip, no event" outcome the old
		// per-id ErrNoRows branch produced. messages.id is a primary key, so a
		// repeated id in messageIDs collapses to one row here for free.
		candidates, err := fetchDeliveryCandidatesTx(ctx, tx, messageIDs)
		if err != nil {
			return err
		}

		// 2. Self-deliveries dropped, then conversation/thread membership
		// resolved ONCE PER DISTINCT conversation or thread rather than once
		// per message. A bad/spoofed recipientID for one message is excluded,
		// not fatal to the rest of the batch — messageIds can span unrelated
		// conversations — exactly as before.
		deliverable, err := filterDeliverableTx(ctx, tx, recipientID, candidates)
		if err != nil {
			return err
		}
		if len(deliverable) == 0 {
			return tx.Commit(ctx)
		}

		// 3. Claim delivered_at for the whole batch in one statement. The
		// ON CONFLICT … WHERE delivered_at IS NULL guard is unchanged from the
		// per-row version — RETURNING reports exactly the messageIds actually
		// claimed, i.e. everything except a recipient acking the same message
		// twice.
		claimed, err := claimDeliveryTx(ctx, tx, recipientID, deliverable)
		if err != nil {
			return err
		}
		if len(claimed) == 0 {
			return tx.Commit(ctx)
		}

		// 4. One outbox row per newly-claimed message, batched per conversation
		// (its outbox key) since messageIds can span unrelated conversations.
		if err := emitDeliveredEventsTx(ctx, tx, recipientID, deliverable, claimed); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// deliveryCandidate is one message pulled from a MarkDelivered batch, carrying
// everything the membership check and the eventual MessageDelivered event need.
type deliveryCandidate struct {
	messageID string
	orgID     string
	convID    string
	senderID  string
	threadID  *string
}

// fetchDeliveryCandidatesTx batch-reads the messages named by ids. Replaces a
// `SELECT ... WHERE id = $1` per id with one `= ANY($1)` — the same technique
// appendCallsTx uses in calls.go to hydrate a page of calls in three queries
// regardless of the page size.
func fetchDeliveryCandidatesTx(ctx context.Context, tx pgx.Tx, ids []string) ([]deliveryCandidate, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, org_id, conversation_id, sender_id, thread_id
		FROM messages WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deliveryCandidate
	for rows.Next() {
		var c deliveryCandidate
		if err := rows.Scan(&c.messageID, &c.orgID, &c.convID, &c.senderID, &c.threadID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// filterDeliverableTx drops self-deliveries and messages whose recipientID is
// not actually a member of the message's conversation (or thread, when set) —
// the same rule requireConversationMember/requireThreadMember enforce for a
// single id (attachments.go), resolved here once per distinct conversation or
// thread rather than once per message.
//
// Mirrors the original precedence exactly: a message with a thread_id is
// checked against thread membership ONLY, never conversation membership too —
// see MarkRead/MarkReadThread's own doc comments for why a thread can be
// deleted-for-owner independently of the conversation underneath it.
func filterDeliverableTx(
	ctx context.Context, tx pgx.Tx, recipientID string, candidates []deliveryCandidate,
) ([]deliveryCandidate, error) {
	var convIDs, threadIDs []string
	seenConv, seenThread := map[string]bool{}, map[string]bool{}
	for _, c := range candidates {
		if c.senderID == recipientID {
			continue // self-delivery: no-op, and never needs a membership check
		}
		if c.threadID != nil {
			if !seenThread[*c.threadID] {
				seenThread[*c.threadID] = true
				threadIDs = append(threadIDs, *c.threadID)
			}
			continue
		}
		if !seenConv[c.convID] {
			seenConv[c.convID] = true
			convIDs = append(convIDs, c.convID)
		}
	}

	convOrgs, err := conversationOrgsTx(ctx, tx, convIDs, recipientID)
	if err != nil {
		return nil, err
	}
	threadOrgs, err := threadOrgsTx(ctx, tx, threadIDs, recipientID)
	if err != nil {
		return nil, err
	}

	out := make([]deliveryCandidate, 0, len(candidates))
	for _, c := range candidates {
		if c.senderID == recipientID {
			continue
		}
		if c.threadID != nil {
			if threadOrgs[*c.threadID] != c.orgID {
				continue
			}
		} else if convOrgs[c.convID] != c.orgID {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

// conversationOrgsTx reads convIDs' org_id, keyed by conversation id, but ONLY
// for conversations where recipientID is actually one of the two participants
// — the same "you are user_low or user_high" rule requireConversationMember
// enforces one id at a time. An id absent from the result failed that check,
// whatever its org.
func conversationOrgsTx(
	ctx context.Context, tx pgx.Tx, convIDs []string, recipientID string,
) (map[string]string, error) {
	out := map[string]string{}
	if len(convIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id, org_id, user_low, user_high
		FROM conversations WHERE id = ANY($1)`, convIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, orgID, low, high string
		if err := rows.Scan(&id, &orgID, &low, &high); err != nil {
			return nil, err
		}
		if recipientID == low || recipientID == high {
			out[id] = orgID
		}
	}
	return out, rows.Err()
}

// threadOrgsTx reads threadIDs' org_id, keyed by thread id, but ONLY for
// threads recipientID actually has a thread_members row for — the same rule
// requireThreadMember enforces one id at a time.
func threadOrgsTx(
	ctx context.Context, tx pgx.Tx, threadIDs []string, recipientID string,
) (map[string]string, error) {
	out := map[string]string{}
	if len(threadIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT t.id, t.org_id
		FROM threads t
		JOIN thread_members tm ON tm.thread_id = t.id AND tm.user_id = $2
		WHERE t.id = ANY($1)`, threadIDs, recipientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, orgID string
		if err := rows.Scan(&id, &orgID); err != nil {
			return nil, err
		}
		out[id] = orgID
	}
	return out, rows.Err()
}

// claimDeliveryTx claims message_delivery.delivered_at for every candidate in
// one statement. The ON CONFLICT … WHERE guard is unchanged from the per-row
// version: a message already delivered to this recipient is left untouched
// and excluded from RETURNING, which is how the caller tells a fresh claim
// from a duplicate ack without a second round trip.
func claimDeliveryTx(
	ctx context.Context, tx pgx.Tx, recipientID string, candidates []deliveryCandidate,
) ([]string, error) {
	ids := make([]string, len(candidates))
	for i, c := range candidates {
		ids[i] = c.messageID
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO message_delivery (message_id, recipient_id, delivered_at)
		SELECT unnest($1::uuid[]), $2, now()
		ON CONFLICT (message_id, recipient_id)
		DO UPDATE SET delivered_at = COALESCE(message_delivery.delivered_at, now())
		WHERE message_delivery.delivered_at IS NULL
		RETURNING message_id`, ids, recipientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var claimed []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		claimed = append(claimed, id)
	}
	return claimed, rows.Err()
}

// emitDeliveredEventsTx writes one MessageDelivered outbox row per
// newly-claimed message, batched per conversation — messageIds can span
// unrelated conversations, so a single insertOutboxBatch call (one kafka key)
// cannot cover the whole page the way it does for e.g. AddMembers.
func emitDeliveredEventsTx(
	ctx context.Context, tx pgx.Tx, recipientID string,
	deliverable []deliveryCandidate, claimedIDs []string,
) error {
	claimed := make(map[string]bool, len(claimedIDs))
	for _, id := range claimedIDs {
		claimed[id] = true
	}

	byConv := map[string][]any{}
	var convOrder []string
	for _, c := range deliverable {
		if !claimed[c.messageID] {
			continue
		}
		evt := events.MessageDelivered{
			Type:           events.TypeMessageDelivered,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          c.orgID,
			OccurredAt:     nowISO(),
			ConversationID: c.convID,
			ThreadID:       c.threadID,
			MessageID:      c.messageID,
			SenderID:       c.senderID,
			RecipientID:    recipientID,
			DeliveredAt:    nowISO(),
		}
		if _, ok := byConv[c.convID]; !ok {
			convOrder = append(convOrder, c.convID)
		}
		byConv[c.convID] = append(byConv[c.convID], evt)
	}
	for _, convID := range convOrder {
		if err := insertOutboxBatch(ctx, tx, convID, byConv[convID]); err != nil {
			return err
		}
	}
	return nil
}

// MarkRead advances the caller's last_read_seq and emits message.read.
// Also (new in Phase 1) zeros the caller's unread count for every thread in
// this conversation up through upToSeq and stamps message_delivery.read_at.
func (s *Store) MarkRead(ctx context.Context, orgID, callerID, convID string, upToSeq int64) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: scope this tx to the caller's org before any RLS table is touched.
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		low, high, _, err := conversationMembers(ctx, tx, orgID, convID, callerID)
		if err != nil {
			return err
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

		// Never trust the requested seq past what exists (see read_ceiling.go).
		// The clamp comes before the cursor moves AND before the event below
		// reads upToSeq, so the peer is never told about seqs that do not exist.
		// prevReadSeq is clamped too, so a cursor an older build pushed to
		// MaxInt64 does not leave the receipt window below empty forever.
		ceiling, err := conversationSeqCeiling(ctx, tx, convID)
		if err != nil {
			return err
		}
		upToSeq := min(upToSeq, ceiling) // new variable: a retry re-clamps from the caller's value
		prevReadSeq = min(prevReadSeq, ceiling)

		if _, err = tx.Exec(ctx,
			`UPDATE conversation_members SET last_read_seq = LEAST(GREATEST(last_read_seq, $3), $4)
			 WHERE conversation_id = $1 AND user_id = $2`,
			convID, callerID, upToSeq, ceiling); err != nil {
			return err
		}

		// Advance per-thread last_read_seq for every thread the caller is a
		// member of in this conversation, where the caller's seen frontier moved.
		if _, err = tx.Exec(ctx, `
			UPDATE thread_members tm
			SET last_read_seq = LEAST(GREATEST(tm.last_read_seq, $3), $4)
			FROM threads t
			WHERE tm.thread_id = t.id
			  AND tm.user_id = $2
			  AND t.conversation_id = $1`,
			convID, callerID, upToSeq, ceiling); err != nil {
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
	})
}

// MarkReadThread is the thread-scoped variant called by POST /threads/{id}/read
// in Phase 3. It only touches the one thread's last_read_seq + the matching
// inbox_items row, then emits MessageRead with threadId set.
func (s *Store) MarkReadThread(ctx context.Context, orgID, callerID, threadID string, upToSeq int64) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
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

		// Clamp to what exists, exactly as MarkRead does (see read_ceiling.go).
		// The unified inbox's THREAD "read" sends math.MaxInt64 meaning "all of
		// it"; this is what turns that into "everything sent so far".
		ceiling, err := conversationSeqCeiling(ctx, tx, convID)
		if err != nil {
			return err
		}
		upToSeq := min(upToSeq, ceiling) // new variable: a retry re-clamps from the caller's value
		prevReadSeq = min(prevReadSeq, ceiling)

		if _, err = tx.Exec(ctx, `
			UPDATE thread_members
			SET last_read_seq = LEAST(GREATEST(last_read_seq, $3), $4)
			WHERE thread_id = $1 AND user_id = $2`,
			threadID, callerID, upToSeq, ceiling); err != nil {
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
	})
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
		if err := requireConversationMember(ctx, tx, orgID, convID, callerID); err != nil {
			return err
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
