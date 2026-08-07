package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// SendMessage starts (or revives) the 1:1 conversation between sender and recipient
// and appends a top-level message. Idempotent on (conversation, sender, clientMsgId).
//
// "Top-level" = no parentMessageId → a NEW thread is created in the same tx.
// `kind` is a MessageKind* constant ("" → text); the API layer whitelists it.
func (s *Store) SendMessage(ctx context.Context, orgID, senderID, recipientID, body, clientMsgID, kind string) (*SendResult, error) {
	if senderID == recipientID {
		return nil, fmt.Errorf("cannot message self")
	}
	low, high := orderedPair(senderID, recipientID)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	// Ensure the conversation row exists (ordered pair, unique per org).
	convID := uuid.Must(uuid.NewV7()).String()
	err = tx.QueryRow(ctx,
		`INSERT INTO conversations (id, org_id, user_low, user_high)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (org_id, user_low, user_high) DO UPDATE SET org_id = EXCLUDED.org_id
		 RETURNING id`,
		convID, orgID, low, high).Scan(&convID)
	if err != nil {
		return nil, err
	}

	// Block gates sends in BOTH directions: if EITHER member blocked the other,
	// nobody in this 1:1 can send until every member row is unblocked. (A prior
	// version only checked the sender's own row, which let the blocked peer keep
	// messaging in.)
	var convBlocked bool
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(bool_or(blocked), false) FROM conversation_members
		 WHERE conversation_id = $1`, convID).Scan(&convBlocked)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if convBlocked {
		return nil, ErrForbidden
	}

	// Upsert BOTH members, revive visibility on send.
	if err := s.upsertMember(ctx, tx, convID, orgID, senderID, true); err != nil {
		return nil, err
	}
	if err := s.upsertMember(ctx, tx, convID, orgID, recipientID, true); err != nil {
		return nil, err
	}

	// Top-level send → new thread, this message is the root.
	return s.appendMessage(ctx, tx, orgID, convID, senderID, recipientID, body, clientMsgID, "", "", appendOpts{kind: kind})
}

// Reply appends a message to an existing conversation; the caller must be a member.
// If parentMessageID is empty the reply nests under the conversation's *most recent*
// thread (rare; used by legacy /conversations/{id}/reply with no thread context).
func (s *Store) Reply(ctx context.Context, orgID, senderID, convID, body, clientMsgID string) (*SendResult, error) {
	return s.replyImpl(ctx, orgID, senderID, convID, "", body, clientMsgID)
}

// ReplyToThread appends a message under a specific parent (Phase 3 /threads
// path). If parentMessageID == "", appends as a sibling of the thread root.
func (s *Store) ReplyToThread(ctx context.Context, orgID, senderID, threadID, parentMessageID, body, clientMsgID string) (*SendResult, error) {
	// Look up the conv from the thread; defense against cross-thread sneaking.
	// RLS: the threads read runs inside withOrg so app.org_id is set.
	var convID string
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		serr := tx.QueryRow(ctx,
			`SELECT conversation_id FROM threads WHERE id = $1 AND org_id = $2`,
			threadID, orgID).Scan(&convID)
		if errors.Is(serr, pgx.ErrNoRows) {
			return ErrForbidden
		}
		return serr
	})
	if err != nil {
		return nil, err
	}
	return s.replyImpl(ctx, orgID, senderID, convID, parentMessageID, body, clientMsgID)
}

func (s *Store) replyImpl(ctx context.Context, orgID, senderID, convID, parentMessageID, body, clientMsgID string) (*SendResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	var low, high, cOrg string
	err = tx.QueryRow(ctx,
		`SELECT org_id, user_low, user_high FROM conversations WHERE id = $1`, convID).
		Scan(&cOrg, &low, &high)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if senderID != low && senderID != high {
		return nil, ErrForbidden
	}

	// Block gates sends in BOTH directions: if EITHER member blocked the other,
	// nobody in this 1:1 can send until every member row is unblocked. (A prior
	// version only checked the sender's own row, which let the blocked peer keep
	// messaging in.)
	var convBlocked bool
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(bool_or(blocked), false) FROM conversation_members
		 WHERE conversation_id = $1`, convID).Scan(&convBlocked)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if convBlocked {
		return nil, ErrForbidden
	}

	recipientID := high
	if senderID == high {
		recipientID = low
	}

	// Revive visibility for both members on a reply.
	if err := s.upsertMember(ctx, tx, convID, orgID, low, true); err != nil {
		return nil, err
	}
	if err := s.upsertMember(ctx, tx, convID, orgID, high, true); err != nil {
		return nil, err
	}

	return s.appendMessage(ctx, tx, orgID, convID, senderID, recipientID, body, clientMsgID, parentMessageID, "", appendOpts{})
}

// appendMessage allocates a seq, inserts the message (idempotent), creates or
// joins the right thread, writes inbox_items rows for BOTH sender and
// recipient in the same tx, and emits MessageCreated through the outbox.
//
// parentMessageID == "" + threadIDHint == "" → top-level send (new thread).
// parentMessageID != ""                       → reply (inherit parent's thread).
// parentMessageID == "" + threadIDHint != ""  → server-chosen thread (legacy
//
//	/conversations/{id}/reply
//	without explicit parent).
func (s *Store) appendMessage(
	ctx context.Context,
	tx pgx.Tx,
	orgID, convID, senderID, recipientID, body, clientMsgID string,
	parentMessageID, threadIDHint string,
	opts appendOpts,
) (*SendResult, error) {
	// Idempotency: include thread_id in the lookup so a per-thread clientMsgId
	// dedupe matches the new wider UNIQUE constraint. The pre-check is cheaper
	// than catching the unique-violation, and importantly the second-write
	// rollback would lose the inbox_items upserts.
	var existingID string
	var existingSeq int64
	var existingThread *string
	err := tx.QueryRow(ctx,
		`SELECT id, seq, thread_id FROM messages
		 WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
		convID, senderID, clientMsgID).Scan(&existingID, &existingSeq, &existingThread)
	if err == nil {
		if cerr := tx.Commit(ctx); cerr != nil {
			return nil, cerr
		}
		out := &SendResult{ConversationID: convID, MessageID: existingID, Seq: existingSeq}
		if existingThread != nil {
			out.ThreadID = *existingThread
		}
		return out, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	// Allocate the next seq atomically.
	var seq int64
	err = tx.QueryRow(ctx,
		`UPDATE conversations SET seq_counter = seq_counter + 1, last_msg_at = now()
		 WHERE id = $1 RETURNING seq_counter`, convID).Scan(&seq)
	if err != nil {
		return nil, err
	}

	msgID := uuid.Must(uuid.NewV7()).String()

	// Resolve thread & parent before INSERT so the row carries the right keys.
	var (
		threadID     string
		isThreadRoot bool
		parentArg    *string
	)
	switch {
	case parentMessageID != "":
		// Reply with explicit parent — inherit parent's thread.
		var rootSender, rootRecipient string
		threadID, rootSender, rootRecipient, err = resolveThreadForReply(ctx, tx, convID, parentMessageID)
		_ = rootSender
		_ = rootRecipient
		if err != nil {
			return nil, err
		}
		parentArg = &parentMessageID
	case threadIDHint != "":
		// Server-chosen thread (legacy reply with no parent).
		threadID = threadIDHint
	default:
		// Top-level — create a new thread with THIS message as root.
		threadID, err = s.ensureThread(ctx, tx, orgID, convID, msgID, senderID, recipientID, body)
		if err != nil {
			return nil, err
		}
		isThreadRoot = true
	}

	// Encrypt the body under the org DEK (created lazily in THIS tx). The
	// plaintext column is left NULL — body_enc is the source of truth.
	bodyEnc, err := s.crypto.Encrypt(ctx, tx, orgID, body)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO messages
		   (id, org_id, conversation_id, seq, sender_id, body, body_enc, client_msg_id,
		    thread_id, parent_message_id, is_thread_root, server_acked_at,
		    is_forward, forwarded_from_message_id, kind)
		 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, now(), $11, $12, $13)`,
		msgID, orgID, convID, seq, senderID, bodyEnc, clientMsgID,
		threadID, parentArg, isThreadRoot,
		opts.isForwardMsg(), opts.forwardedFromArg(), opts.kindArg())
	if err != nil {
		return nil, err
	}

	// Always bump the thread so last_message_seq reflects this insert. For the
	// root message the thread row's DEFAULT 0 last_message_seq would otherwise
	// linger until the first reply, leaving GetThread reporting a stale seq.
	if err := bumpThread(ctx, tx, threadID, seq); err != nil {
		return nil, err
	}

	// Inbox projection — same tx, with monotonic last_event_at guard. Sender
	// row never bumps unread (their own send); recipient row +1.
	preview := truncatePreview(body)
	now := time.Now().UTC()
	if err := s.upsertThreadInboxItem(ctx, tx, orgID, senderID, threadID, recipientID, preview, "SENT", now, 0); err != nil {
		return nil, err
	}
	if err := s.upsertThreadInboxItem(ctx, tx, orgID, recipientID, threadID, senderID, preview, "", now, 1); err != nil {
		return nil, err
	}

	// MessageCreated outbox payload carries the threading fields (post-Phase 0
	// Zod widening; legacy consumers default threadId ← conversationId).
	parentForEvent := parentArg
	rootForEvent := isThreadRoot
	threadIDForEvent := threadID
	evt := events.MessageCreated{
		Type:            events.TypeMessageCreated,
		EventID:         uuid.Must(uuid.NewV7()).String(),
		OrgID:           orgID,
		OccurredAt:      nowISO(),
		ConversationID:  convID,
		MessageID:       msgID,
		Seq:             seq,
		SenderID:        senderID,
		RecipientID:     recipientID,
		Body:            body,
		ClientMsgID:     clientMsgID,
		ThreadID:        &threadIDForEvent,
		ParentMessageID: parentForEvent,
		IsThreadRoot:    &rootForEvent,
		Kind:            opts.kind, // empty for ordinary text
	}
	if err := insertOutbox(ctx, tx, events.TopicMessaging, convID, evt); err != nil {
		return nil, err
	}

	// Forward provenance — recorded in the SAME tx as the clone, so A can never
	// observe a forwarded message without its edge, and the ORIGINAL author is
	// notified live. The clone above already emitted MessageCreated (which owns
	// the recipient's chat/inbox/badges); this is the separate provenance signal.
	if f := opts.forward; f != nil {
		fwdPath := append(append([]string{}, f.path...), msgID) // root..this clone
		if _, err := tx.Exec(ctx,
			`INSERT INTO message_forwards
			   (id, org_id, root_message_id, root_author_id, parent_message_id,
			    forwarded_message_id, forwarded_by, forwarded_to, forwarded_to_external,
			    platform, depth, path)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11::uuid[])`,
			uuid.Must(uuid.NewV7()).String(), orgID, f.rootMessageID, f.rootAuthorID,
			f.parentMessageID, msgID, f.forwardedBy, recipientID, f.platform, f.depth,
			fwdPath); err != nil {
			return nil, err
		}

		fThreadID := threadID
		fwdEvt := events.MessageForwarded{
			Type:               events.TypeMessageForwarded,
			EventID:            uuid.Must(uuid.NewV7()).String(),
			OrgID:              orgID,
			OccurredAt:         nowISO(),
			ConversationID:     convID,
			RootMessageID:      f.rootMessageID,
			RootAuthorID:       f.rootAuthorID,
			ParentMessageID:    f.parentMessageID,
			ForwardedBy:        f.forwardedBy,
			ForwardedTo:        recipientID,
			Platform:           f.platform,
			Depth:              f.depth,
			BodyPreview:        preview,
			ForwardedMessageID: msgID,
			ThreadID:           &fThreadID,
			Seq:                seq,
		}
		if err := insertOutbox(ctx, tx, events.TopicMessaging, convID, fwdEvt); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &SendResult{
		ConversationID: convID,
		ThreadID:       threadID,
		MessageID:      msgID,
		Seq:            seq,
	}, nil
}
