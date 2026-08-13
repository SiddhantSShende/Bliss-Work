package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/events"
)

// previewLen caps the subject preview stored on the threads row + inbox_items.
const previewLen = 80

// Which surface started a thread, and therefore whether it belongs in the
// Inbox. Chats is instant messaging; the Inbox is an email-style surface, and
// before this distinction existed every DM wrote an inbox_items row — which is
// why chat traffic showed up in the Inbox's badge and People sidebar.
const (
	ThreadOriginChat = "chat"
	ThreadOriginMail = "mail"
)

// ValidThreadOrigin reports whether a CLIENT-SUPPLIED origin is one we accept.
func ValidThreadOrigin(v string) bool {
	return v == ThreadOriginChat || v == ThreadOriginMail
}

// ThreadDTO is the per-thread header returned by GET /threads/{id}.
type ThreadDTO struct {
	ThreadID       string `json:"threadId"`
	ConversationID string `json:"conversationId"`
	RootMessageID  string `json:"rootMessageId"`
	PeerID         string `json:"peerId"`
	PeerUsername   string `json:"peerUsername"`
	// Real name; see ConversationDTO.PeerDisplayName. Empty until the projection
	// catches up, in which case clients fall back to peerUsername.
	PeerDisplayName string `json:"peerDisplayName,omitempty"`
	SubjectPreview  string `json:"subjectPreview"`
	LastEventAt     string `json:"lastEventAt"`
	LastMessageSeq  int64  `json:"lastMessageSeq"`
	UnreadCount     int64  `json:"unreadCount"`
	MyLastReadSeq   int64  `json:"myLastReadSeq"`
}

// ensureThread creates a new thread row + both thread_members rows when the
// caller is sending a root message. Returns the new threadId.
//
// Called from inside appendMessage (Phase 1 dual-write) under the same tx as
// the message insert, so a partial failure rolls everything back.
func (s *Store) ensureThread(
	ctx context.Context,
	tx pgx.Tx,
	orgID, convID, rootMessageID, senderID, recipientID, body, origin string,
) (threadID string, err error) {
	if origin == "" {
		origin = ThreadOriginChat
	}
	threadID = uuid.Must(uuid.NewV7()).String()
	preview := truncatePreview(body)

	// SELECT FOR UPDATE on the parent conversation guards against a concurrent
	// second root-send winning the race and creating two threads for the same
	// "first message" — the loser falls through to the existing row.
	var convOrg string
	if err = tx.QueryRow(ctx,
		`SELECT org_id FROM conversations WHERE id = $1 FOR UPDATE`, convID).
		Scan(&convOrg); err != nil {
		return "", err
	}
	if convOrg != orgID {
		return "", ErrForbidden
	}

	// Encrypt the subject preview under the org DEK (created lazily in this tx);
	// the plaintext subject_preview column is left NULL.
	previewEnc, err := s.crypto.Encrypt(ctx, tx, orgID, preview)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO threads
		   (id, org_id, conversation_id, root_message_id, sender_id, recipient_id,
		    subject_preview, subject_preview_enc, last_event_at, last_message_seq, origin)
		 VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, now(), 0, $8)`,
		threadID, orgID, convID, rootMessageID, senderID, recipientID, previewEnc, origin)
	if err != nil {
		return "", fmt.Errorf("insert thread: %w", err)
	}

	if err = upsertThreadMember(ctx, tx, threadID, orgID, senderID); err != nil {
		return "", err
	}
	if err = upsertThreadMember(ctx, tx, threadID, orgID, recipientID); err != nil {
		return "", err
	}
	return threadID, nil
}

// resolveThreadForReply returns the thread_id and root recipient/sender info
// for a reply, given the parent_message_id. The parent must belong to the
// same conversation (defense against threadId-spoofing on the wire).
func resolveThreadForReply(
	ctx context.Context,
	tx pgx.Tx,
	convID, parentMessageID string,
) (threadID, rootSenderID, rootRecipientID string, err error) {
	row := tx.QueryRow(ctx, `
		SELECT m.thread_id, t.sender_id, t.recipient_id
		FROM messages m
		JOIN threads t ON t.id = m.thread_id
		WHERE m.id = $1 AND m.conversation_id = $2`,
		parentMessageID, convID)
	if err = row.Scan(&threadID, &rootSenderID, &rootRecipientID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", "", ErrForbidden
		}
		return "", "", "", fmt.Errorf("resolve thread for reply: %w", err)
	}
	return threadID, rootSenderID, rootRecipientID, nil
}

// upsertThreadMember inserts/touches a per-(thread, user) state row and
// revives visibility on send. ON CONFLICT keeps last_read_seq intact.
func upsertThreadMember(ctx context.Context, tx pgx.Tx, threadID, orgID, userID string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO thread_members (thread_id, user_id, org_id, hidden_for_owner, hidden_at)
		VALUES ($1, $2, $3, false, NULL)
		ON CONFLICT (thread_id, user_id)
		DO UPDATE SET hidden_for_owner = false, hidden_at = NULL`,
		threadID, userID, orgID)
	return err
}

// bumpThread updates last_event_at + last_message_seq on the thread row after
// any new message lands in it.
func bumpThread(ctx context.Context, tx pgx.Tx, threadID string, seq int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE threads
		SET last_event_at = now(),
		    last_message_seq = GREATEST(last_message_seq, $2)
		WHERE id = $1`, threadID, seq)
	return err
}

// IgnoreThread hides the thread for BOTH members and emits a thread-scoped
// ConversationIgnored event. A subsequent reply revives both members through
// the dual-write path in appendMessage.
func (s *Store) IgnoreThread(ctx context.Context, orgID, callerID, threadID string) error {
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
	var lastSeq int64
	err = tx.QueryRow(ctx, `
		SELECT t.org_id, t.conversation_id, t.sender_id, t.recipient_id, t.last_message_seq
		FROM threads t WHERE t.id = $1`, threadID).
		Scan(&tOrg, &convID, &senderID, &recipientID, &lastSeq)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && tOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if callerID != senderID && callerID != recipientID {
		return ErrForbidden
	}

	// Hide BOTH member rows.
	if _, err = tx.Exec(ctx, `
		UPDATE thread_members
		SET hidden_for_owner = true, hidden_at = now()
		WHERE thread_id = $1`, threadID); err != nil {
		return err
	}

	// Mirror into the inbox_items projection so the unified inbox query
	// excludes the row immediately (avoids one-cycle of stale UI).
	if _, err = tx.Exec(ctx, `
		UPDATE inbox_items
		SET hidden_for_owner = true, updated_at = now()
		WHERE item_kind = 'THREAD' AND ref_id = $1`, threadID); err != nil {
		return err
	}

	evt := events.ConversationIgnored{
		Type:           events.TypeConversationIgnored,
		EventID:        uuid.Must(uuid.NewV7()).String(),
		OrgID:          orgID,
		OccurredAt:     nowISO(),
		ConversationID: convID,
		IgnoredBy:      callerID,
		Members:        []string{senderID, recipientID},
		AtSeq:          lastSeq,
		ThreadID:       &threadID,
	}
	if err = insertOutbox(ctx, tx, convID, evt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetThread returns the thread header for the caller. Returns ErrForbidden if
// the caller isn't a member.
func (s *Store) GetThread(ctx context.Context, orgID, callerID, threadID string) (*ThreadDTO, error) {
	var d ThreadDTO
	// RLS: header read, decrypt, and unread count all run under app.org_id.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var peerID string
		var lastAt time.Time
		var subjectPlain *string
		var subjectEnc []byte
		serr := tx.QueryRow(ctx, `
			SELECT
			    t.id, t.conversation_id, t.root_message_id, t.subject_preview, t.subject_preview_enc,
			    t.last_event_at, t.last_message_seq,
			    CASE WHEN t.sender_id = $2 THEN t.recipient_id ELSE t.sender_id END AS peer_id,
			    COALESCE(up.username, ''),
			    COALESCE(up.display_name, ''),
			    COALESCE(tm.last_read_seq, 0)
			FROM threads t
			JOIN thread_members tm ON tm.thread_id = t.id AND tm.user_id = $2
			LEFT JOIN user_projection up
			    ON up.user_id = (CASE WHEN t.sender_id = $2 THEN t.recipient_id ELSE t.sender_id END)
			WHERE t.id = $1 AND t.org_id = $3`,
			threadID, callerID, orgID).
			Scan(
				// dest[5] is t.last_event_at (timestamptz) → scan into a time.Time,
				// NOT a *string. dest[7] (&d.PeerID) already maps the peer_id column.
				&d.ThreadID, &d.ConversationID, &d.RootMessageID, &subjectPlain, &subjectEnc,
				&lastAt, &d.LastMessageSeq, &peerID, &d.PeerUsername, &d.PeerDisplayName, &d.MyLastReadSeq,
			)
		if errors.Is(serr, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if serr != nil {
			return serr
		}
		// subject_preview_enc is the source of truth; fall back to the legacy
		// plaintext column for un-backfilled rows.
		if subjectEnc != nil {
			dec, derr := s.crypto.Decrypt(ctx, tx, orgID, subjectEnc)
			if derr != nil {
				return derr
			}
			d.SubjectPreview = dec
		} else if subjectPlain != nil {
			d.SubjectPreview = *subjectPlain
		}
		d.PeerID = peerID
		// last_event_at was previously scanned into the wrong dest (a *string),
		// 500-ing this endpoint and leaving LastEventAt empty. Populate it now.
		d.LastEventAt = lastAt.UTC().Format("2006-01-02T15:04:05.000Z")
		// Unread = messages from peer with seq > my last_read_seq.
		return tx.QueryRow(ctx, `
			SELECT count(*) FROM messages
			WHERE thread_id = $1 AND sender_id <> $2 AND seq > $3`,
			threadID, callerID, d.MyLastReadSeq).Scan(&d.UnreadCount)
	})
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// ListThreadMessages returns up to limit messages with seq < beforeSeq, ordered
// DESC. The client reverses for ascending render.
func (s *Store) ListThreadMessages(
	ctx context.Context, orgID, callerID, threadID string,
	beforeSeq int64, limit int,
) ([]MessageDTO, error) {
	if limit <= 0 || limit > 50 {
		limit = 16
	}
	// beforeSeq = 0 means "from the newest" (large sentinel).
	if beforeSeq <= 0 {
		beforeSeq = 1<<62 - 1
	}

	out := []MessageDTO{}
	// RLS: membership check, message read, and per-row decrypt all under app.org_id.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Membership check.
		var present int
		if err := tx.QueryRow(ctx,
			`SELECT 1 FROM thread_members WHERE thread_id = $1 AND user_id = $2`,
			threadID, callerID).Scan(&present); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}

		rows, err := tx.Query(ctx, `
			SELECT`+messageColumns+`
			FROM messages m`+messageDeliveryJoin+`
			WHERE m.thread_id = $1 AND m.seq < $2
			  AND (m.sender_id <> $3 OR m.sender_dismissed_at IS NULL)
			  -- "Delete for me": one reader's decision, invisible to the other.
			  AND NOT EXISTS (
			      SELECT 1 FROM message_hides h
			      WHERE h.message_id = m.id AND h.user_id = $3
			  )
			ORDER BY m.seq DESC
			LIMIT $4`,
			threadID, beforeSeq, callerID, limit)
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
			// See ListMessages: a receipt only means something on my own
			// messages.
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

// DismissMessage sets sender_dismissed_at on a message the caller authored.
// Hides only from the sender's own view; the recipient is unaffected.
func (s *Store) DismissMessage(ctx context.Context, orgID, callerID, messageID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	var msgOrg, msgSender, convID string
	var threadIDNullable *string
	err = tx.QueryRow(ctx,
		`SELECT org_id, sender_id, conversation_id, thread_id FROM messages WHERE id = $1`,
		messageID).Scan(&msgOrg, &msgSender, &convID, &threadIDNullable)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && msgOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if msgSender != callerID {
		return ErrForbidden
	}

	if _, err = tx.Exec(ctx,
		`UPDATE messages SET sender_dismissed_at = now()
		 WHERE id = $1 AND sender_dismissed_at IS NULL`, messageID); err != nil {
		return err
	}

	// Recompute the sender's inbox_items.last_event_at to the second-newest
	// non-dismissed message in the same thread. If no other messages remain,
	// the row stays at its last value (the projector will overwrite on next
	// activity).
	if threadIDNullable != nil {
		if _, err = tx.Exec(ctx, `
			UPDATE inbox_items i
			SET last_event_at = COALESCE((
			    SELECT max(m.created_at)
			    FROM messages m
			    WHERE m.thread_id = $1
			      AND (m.sender_id <> $2 OR m.sender_dismissed_at IS NULL)
			), i.last_event_at),
			updated_at = now()
			WHERE i.owner_user_id = $2
			  AND i.item_kind = 'THREAD'
			  AND i.ref_id = $1`,
			*threadIDNullable, callerID); err != nil {
			return err
		}
	}

	evt := events.MessageDismissed{
		Type:           events.TypeMessageDismissed,
		EventID:        uuid.Must(uuid.NewV7()).String(),
		OrgID:          orgID,
		OccurredAt:     nowISO(),
		ConversationID: convID,
		ThreadID:       threadIDNullable,
		MessageID:      messageID,
		DismissedBy:    callerID,
	}
	if err = insertOutbox(ctx, tx, convID, evt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// envelopeSentinel (U+001F, Unit Separator) marks the boundary between the
// human-readable prefix of a structured message body and its machine-readable
// JSON payload. The clients encode file offers, media attachments and shared
// locations this way (see packages/app/src/lib/chatEnvelope.ts) so that
// structured messages need no schema change and stay encrypted with the body.
const envelopeSentinel = ''

// truncatePreview produces the per-thread subject preview shown in the inbox
// list. Strips newlines and collapses whitespace so the preview is one line.
//
// Two subtleties, both of which used to be bugs:
//
//  1. Structured bodies carry a JSON payload after a U+001F sentinel. Only the
//     readable prefix belongs in a preview — otherwise the inbox row reads
//     `📎 photo.jpg · 2.1 MB␟{"v":2,"kind":"media","items":[{"id":"018f…`.
//  2. previewLen is a BYTE budget, and the readable prefixes start with a
//     4-byte emoji. Slicing bytes can cut a rune in half, producing invalid
//     UTF-8 that survives encryption and comes back as U+FFFD. Truncate on
//     rune boundaries instead.
func truncatePreview(body string) string {
	if i := strings.IndexRune(body, envelopeSentinel); i >= 0 {
		body = body[:i]
	}
	clean := strings.ReplaceAll(body, "\r", " ")
	clean = strings.ReplaceAll(clean, "\n", " ")
	clean = strings.Join(strings.Fields(clean), " ")
	if len(clean) <= previewLen {
		return clean
	}
	// Walk back to the last rune boundary at or before the byte budget.
	cut := previewLen
	for cut > 0 && !utf8.RuneStart(clean[cut]) {
		cut--
	}
	return clean[:cut]
}

// rawMessage holds one message row's columns BEFORE the body is decrypted. The
// readers buffer a slice of these so the row cursor is fully drained before any
// Decrypt query runs on the same tx (issuing a query while pgx.Rows is open on
// that tx errors with "conn busy").
type rawMessage struct {
	m       MessageDTO
	bodyTxt *string
	bodyEnc []byte
}

// messageColumns is the SELECT list every message reader uses, in exactly the
// order scanRawMessage expects. Shared as a constant because there are two
// readers (conversations and threads) and a column added to one but not the
// other is a scan-order bug that only shows up at runtime.
//
// `status` is the sender-side receipt, computed from the single message_delivery
// row the 1:1 recipient owns. It is SELECTed rather than accumulated on the
// client because a receipt held only in a cache patch dies with the page — which
// is why sent messages showed no delivery state at all after a reload.
const messageColumns = `
	m.id, m.conversation_id, m.thread_id, m.parent_message_id, m.is_thread_root,
	m.seq, m.sender_id, m.body, m.body_enc, m.created_at, m.sender_dismissed_at, m.kind,
	m.reply_to_id, m.deleted_for_all_at,
	CASE
	    WHEN md.read_at      IS NOT NULL THEN 'SEEN'
	    WHEN md.delivered_at IS NOT NULL THEN 'DELIVERED'
	    ELSE 'SENT'
	END AS status`

// messageDeliveryJoin pairs with messageColumns. `recipient_id <> m.sender_id`
// identifies the other party without needing to know who they are: a 1:1
// conversation has exactly one delivery row per message, belonging to the peer.
const messageDeliveryJoin = `
	LEFT JOIN message_delivery md
	       ON md.message_id = m.id AND md.recipient_id <> m.sender_id`

// scanRawMessage decodes one messageColumns row WITHOUT touching the DB — pure
// column copy, safe to call inside rows.Next(). The body is left encrypted in
// rawMessage.bodyEnc for a later decryptMessage call.
func scanRawMessage(rows pgx.Rows) (rawMessage, error) {
	var (
		r                 rawMessage
		threadID          *string
		parentMsgID       *string
		isThreadRoot      bool
		bodyPlain         *string
		bodyEnc           []byte
		created           time.Time
		senderDismissedAt *time.Time
		replyToID         *string
		deletedForAllAt   *time.Time
		status            string
	)
	var kind string
	if err := rows.Scan(
		&r.m.ID, &r.m.ConversationID, &threadID, &parentMsgID, &isThreadRoot,
		&r.m.Seq, &r.m.SenderID, &bodyPlain, &bodyEnc, &created, &senderDismissedAt, &kind,
		&replyToID, &deletedForAllAt, &status,
	); err != nil {
		return rawMessage{}, err
	}
	if replyToID != nil {
		r.m.ReplyToID = *replyToID
	}
	r.m.Status = status
	r.m.DeletedForAll = deletedForAllAt != nil
	// 'text' is the overwhelming majority; omit it so the wire shape for an
	// ordinary message is byte-identical to what clients saw before.
	if kind != MessageKindText {
		r.m.Kind = kind
	}
	if threadID != nil {
		r.m.ThreadID = *threadID
	}
	r.m.ParentMessageID = parentMsgID
	r.m.IsThreadRoot = isThreadRoot
	r.m.CreatedAt = created.UTC().Format("2006-01-02T15:04:05.000Z")
	r.m.DismissedBySender = senderDismissedAt != nil
	r.bodyTxt = bodyPlain
	r.bodyEnc = bodyEnc
	return r, nil
}

// decryptMessage resolves the plaintext body from a rawMessage. body_enc is the
// source of truth; the legacy plaintext column is the fallback for un-backfilled
// rows. q must be a Querier whose connection has app.org_id set (the RLS-scoped
// tx) so the org_keys lookup the Cryptor performs is visible. orgID scopes the
// DEK + AAD. MUST be called AFTER the row cursor that produced the rawMessage is
// closed.
func (s *Store) decryptMessage(ctx context.Context, q crypto.Querier, orgID string, r rawMessage) (MessageDTO, error) {
	m := r.m
	// A message deleted for everyone travels as a TOMBSTONE: the row is still
	// there (seq is the conversation's ordering key, and message_delivery and
	// message_forwards reference the id), but the body never leaves the server.
	// Skipping the decrypt is the point — "deleted" that still ships the text
	// to every client and merely hides it in CSS is not deletion.
	if m.DeletedForAll {
		m.Body = ""
		return m, nil
	}
	if r.bodyEnc != nil {
		dec, err := s.crypto.Decrypt(ctx, q, orgID, r.bodyEnc)
		if err != nil {
			return MessageDTO{}, err
		}
		m.Body = dec
	} else if r.bodyTxt != nil {
		m.Body = *r.bodyTxt
	}
	return m, nil
}
