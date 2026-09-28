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
// SendOptions carries the optional extras a send may specify. All are validated
// by the API layer before they reach here; a zero value is an ordinary chat
// message with no quote.
type SendOptions struct {
	// Kind is a MessageKind* constant ("" → text). System entries only.
	Kind string
	// Origin is the surface starting the thread — ThreadOriginChat unless the
	// Compose dialog asked for mail. Only meaningful on a top-level send; a
	// reply inherits its thread's.
	Origin string
	// ReplyToID is the message being quoted, in the same conversation.
	ReplyToID string
	// AttachmentID is required when Kind is MessageKindAttachmentOpened or
	// MessageKindAttachmentDownloaded — see attachmentForActivity.
	AttachmentID string
}

func (s *Store) SendMessage(ctx context.Context, orgID, senderID, recipientID, body, clientMsgID string, opts SendOptions) (*SendResult, error) {
	if senderID == recipientID {
		return nil, fmt.Errorf("cannot message self")
	}
	low, high := orderedPair(senderID, recipientID)

	var out *SendResult
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: scope this tx to the caller's org before any RLS table is touched.
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		// The recipient must belong to this org. Without it a send opens a
		// conversation with a user id guessed from another org: the upsert below
		// stamps the row with OUR org_id, RLS is satisfied, and the resulting
		// message.created is routed to the foreign user by id alone.
		if err := requireSameOrgUser(ctx, tx, orgID, recipientID); err != nil {
			return err
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
			return err
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
			return err
		}
		if convBlocked {
			return ErrForbidden
		}

		// Upsert BOTH members, revive visibility on send.
		if err := s.upsertMember(ctx, tx, convID, orgID, senderID); err != nil {
			return err
		}
		if err := s.upsertMember(ctx, tx, convID, orgID, recipientID); err != nil {
			return err
		}

		// Top-level send → new thread, this message is the root.
		res, err := s.appendMessage(ctx, tx, orgID, convID, senderID, recipientID, body, clientMsgID, "", "",
			appendOpts{kind: opts.Kind, origin: opts.Origin, replyToID: opts.ReplyToID, attachmentID: opts.AttachmentID})
		if err != nil {
			return err
		}
		out = res
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// blockedPairTx is the tx-scoped block lookup IsBlockedPair and
// CreateDirectCall's in-transaction check both share, so a caller that
// already holds an open transaction (CreateDirectCall) can ask the question
// without opening a second one — RLS is scoped per-transaction via the
// app.org_id GUC, and a nested Begin would just be a second connection
// answering the same question under the same GUC value.
//
// Read-only and side-effect free: unlike SendMessage/OpenConversation, this
// does NOT create a conversation row for a pair that has never had one — a
// call-authorization check must not have the side effect of making two
// strangers visible to each other. bool_or over zero matched rows is NULL,
// which COALESCE turns into false, so a pair with no conversation yet is
// correctly "not blocked."
func blockedPairTx(ctx context.Context, tx pgx.Tx, orgID, userA, userB string) (bool, error) {
	low, high := orderedPair(userA, userB)
	var blocked bool
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(bool_or(cm.blocked), false)
		 FROM conversation_members cm
		 JOIN conversations c ON c.id = cm.conversation_id
		 WHERE c.org_id = $1 AND c.user_low = $2 AND c.user_high = $3`,
		orgID, low, high).Scan(&blocked)
	if err != nil {
		return false, err
	}
	return blocked, nil
}

// IsBlockedPair reports whether either user in a pair has blocked the other,
// using the SAME rule SendMessage/Reply enforce above: a block gates BOTH
// directions, because a block only means something if the blocked person can
// no longer reach the blocker either.
//
// Used by the /internal/calls/blocked endpoint ws-gateway calls before
// forwarding a call.invite — the actual authorization boundary for a 1:1
// ring, since CreateDirectCall's row is written best-effort and does not gate
// delivery of the WebSocket invite (see useCall.tsx's backWithRecord on the
// frontend). CreateDirectCall runs the same check itself via blockedPairTx,
// against its own already-open transaction, as defense in depth on the
// call-history write.
func (s *Store) IsBlockedPair(ctx context.Context, orgID, userA, userB string) (bool, error) {
	var blocked bool
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		blocked, err = blockedPairTx(ctx, tx, orgID, userA, userB)
		return err
	})
	if err != nil {
		return false, err
	}
	return blocked, nil
}

// Reply appends a message to an existing conversation; the caller must be a member.
// If parentMessageID is empty the reply nests under the conversation's *most recent*
// thread (this is DMView's normal send path — /conversations/{id}/reply carries no
// thread context at all, so every chat message except a brand-new conversation's
// first goes through here with no parent).
func (s *Store) Reply(ctx context.Context, orgID, senderID, convID, body, clientMsgID, replyToID string) (*SendResult, error) {
	return s.replyImpl(ctx, orgID, senderID, convID, "", "", body, clientMsgID, replyToID, true, "", "")
}

// ReplyAttachmentActivity appends a MessageKindAttachmentOpened/Downloaded
// system entry to convID's most-recently-active thread — the same thread an
// ordinary chat message reaches via Reply — instead of going through
// SendMessage, whose top-level-send branch mints a brand-new one-message
// thread on every call (see appendMessageTx's threadIDHint comment). A file
// can be opened or downloaded far more often than the rare event
// MessageKindScreenshotAttempt was designed for, and minting a thread per
// occurrence would also hijack Reply's most-recent-thread fallback, nesting
// the user's next real chat message under a throwaway activity notice
// instead of the actual conversation.
//
// body is deliberately not a parameter: appendMessageTx always overwrites it
// for these two kinds from the attachment row itself (attachmentForActivity),
// so there is nothing for a caller to supply.
func (s *Store) ReplyAttachmentActivity(ctx context.Context, orgID, senderID, convID, kind, attachmentID, clientMsgID string) (*SendResult, error) {
	return s.replyImpl(ctx, orgID, senderID, convID, "", "", "", clientMsgID, "", true, kind, attachmentID)
}

// ReplyToThread appends a message under a specific parent (Phase 3 /threads
// path). If parentMessageID == "", appends as a sibling of the thread root.
//
// Note: this already knows its target thread (threadID, above) — it does NOT
// ask replyImpl to fall back to the conversation's most-recent thread the way
// Reply does, since a conversation can have more than one thread and silently
// substituting a "more recent" one for the caller's explicit threadID would be
// wrong here.
func (s *Store) ReplyToThread(ctx context.Context, orgID, senderID, threadID, parentMessageID, body, clientMsgID, replyToID string) (*SendResult, error) {
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
	return s.replyImpl(ctx, orgID, senderID, convID, threadID, parentMessageID, body, clientMsgID, replyToID, false, "", "")
}

// replyImpl is Reply's and ReplyToThread's shared body. mostRecentThreadFallback
// is Reply's "true" / ReplyToThread's "false" — see each one's doc comment for
// why: only Reply's caller has no thread context of its own to prefer.
//
// knownThreadID is ReplyToThread's already-resolved target thread ("" for
// Reply, which has none). It is threaded straight through to threadIDHint
// below — appendMessageTx only consults threadIDHint when parentMessageID is
// empty, so this has no effect on an explicit-parent reply, but it is exactly
// what keeps a PARENTLESS reply to a known thread appending to THAT thread
// instead of falling into appendMessageTx's top-level-send branch and minting
// an unrelated new one.
//
// kind/attachmentID are ReplyAttachmentActivity's only — "" for Reply and
// ReplyToThread, which pass an ordinary text message through untouched.
func (s *Store) replyImpl(ctx context.Context, orgID, senderID, convID, knownThreadID, parentMessageID, body, clientMsgID, replyToID string, mostRecentThreadFallback bool, kind, attachmentID string) (*SendResult, error) {
	var out *SendResult
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: scope this tx to the caller's org before any RLS table is touched.
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		low, high, _, err := conversationMembers(ctx, tx, orgID, convID, senderID)
		if err != nil {
			return err
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
			return err
		}
		if convBlocked {
			return ErrForbidden
		}

		recipientID := high
		if senderID == high {
			recipientID = low
		}

		// Revive visibility for both members on a reply.
		if err := s.upsertMember(ctx, tx, convID, orgID, low); err != nil {
			return err
		}
		if err := s.upsertMember(ctx, tx, convID, orgID, high); err != nil {
			return err
		}

		// Reply's documented behavior: a parentless reply nests under the
		// conversation's most recently active thread instead of leaving
		// threadIDHint empty, which is what used to send appendMessageTx down
		// its top-level-send branch and mint a brand-new thread (+ 2
		// thread_members rows) for every single chat message.
		//
		// "" stays correct here too: a conversation with no thread yet (this
		// conversation's genuinely first message, also sent through Reply —
		// see its doc comment) still falls through to that same top-level
		// branch and creates the one thread it needs.
		//
		// ReplyToThread already knows its target thread (knownThreadID) and
		// must never be second-guessed by the most-recent-thread lookup below
		// — see this function's doc comment.
		threadIDHint := knownThreadID
		if threadIDHint == "" && parentMessageID == "" && mostRecentThreadFallback {
			// Same lock a new-thread creation takes below, re-entered here
			// (harmless within one tx — see ensureThread's comment) so two
			// concurrent parentless replies to a conversation with no thread
			// yet can't both see "no thread exists" and each mint their own:
			// the loser blocks until the winner's thread commits and is
			// visible to the lookup just below.
			if err := lockConversationForRootSend(ctx, tx, convID, orgID); err != nil {
				return err
			}
			threadIDHint, err = mostRecentThreadID(ctx, tx, convID)
			if err != nil {
				return err
			}
		}

		res, err := s.appendMessage(ctx, tx, orgID, convID, senderID, recipientID, body, clientMsgID, parentMessageID, threadIDHint,
			appendOpts{replyToID: replyToID, kind: kind, attachmentID: attachmentID})
		if err != nil {
			return err
		}
		out = res
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// appendOpts carries optional context into appendMessage. The zero value is an
// ordinary message — SendMessage/Reply pass it.
type appendOpts struct {
	// kind is the messages.kind value ("" → 'text'). System entries such as
	// MessageKindCallMissed set it; it is never taken from raw client input.
	kind string
	// origin is the surface starting a NEW thread — ThreadOriginChat unless
	// Compose asked for mail. Ignored on a reply, which inherits the thread's.
	origin string
	// replyToID quotes another message in the same conversation ("" → none).
	replyToID string
	// messageID lets a caller mint the id BEFORE the insert, for when something
	// written earlier on the same transaction has to reference the row. A
	// forward's provenance edge is exactly that, and it cannot be written
	// afterwards because this function owns the COMMIT. "" → generated here.
	messageID string
	// isForward marks the row as a delivered copy of someone else's message.
	// The reader's client labels it "Forwarded" rather than attributing the
	// content — a forwarded photo that looked authored by the forwarder would
	// misattribute it to them.
	isForward     bool
	forwardedFrom string
	// forwardPlatform is set ONLY by ForwardLinkRecord, to PlatformWhatsApp —
	// never alongside isForward, which marks the DIFFERENT case of an internal
	// forward's clone. See MessageDTO.ForwardPlatform.
	forwardPlatform string
	// attachmentID is required when kind is MessageKindAttachmentOpened or
	// MessageKindAttachmentDownloaded — see attachmentForActivity.
	attachmentID string
}

// kindArg is the messages.kind value to insert — 'text' unless a system kind
// was requested, so every existing call site keeps its current behavior.
func (o appendOpts) kindArg() string {
	if o.kind == "" {
		return MessageKindText
	}
	return o.kind
}

// appendMessage is appendMessageTx plus the commit. Unchanged contract for
// its three call sites (SendMessage, replyImpl, ForwardLinkRecord's DM
// branch), which hand over a transaction they expect closed on return.
func (s *Store) appendMessage(
	ctx context.Context,
	tx pgx.Tx,
	orgID, convID, senderID, recipientID, body, clientMsgID string,
	parentMessageID, threadIDHint string,
	opts appendOpts,
) (*SendResult, error) {
	res, err := s.appendMessageTx(ctx, tx, orgID, convID, senderID, recipientID, body, clientMsgID,
		parentMessageID, threadIDHint, opts)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return res, nil
}

// appendMessageTx is appendMessage on a transaction the CALLER owns and
// commits. Split out because a batch forward appends N messages into ONE
// destination transaction (store/forward_batch.go) — appendMessage's own
// COMMIT, needed by its other three callers, would have closed that
// transaction after the first message and left the rest with nothing open
// to run in.
//
// Allocates a seq, inserts the message (idempotent), creates or joins the
// right thread, writes inbox_items rows for BOTH sender and recipient in the
// same tx, and emits MessageCreated through the outbox.
//
// parentMessageID == "" + threadIDHint == "" → top-level send (new thread).
// parentMessageID != ""                       → reply (inherit parent's thread).
// parentMessageID == "" + threadIDHint != ""  → server-chosen thread (legacy
//
//	/conversations/{id}/reply
//	without explicit parent).
func (s *Store) appendMessageTx(
	ctx context.Context,
	tx pgx.Tx,
	orgID, convID, senderID, recipientID, body, clientMsgID string,
	parentMessageID, threadIDHint string,
	opts appendOpts,
) (*SendResult, error) {
	// See screenshotAttemptBody's doc comment: this kind's body is authored
	// here from the sender's own projected name, never trusted from the
	// caller — done before anything below reads `body` (ensureThread, the
	// encrypt+INSERT, and the inbox preview all have to see the real text).
	if opts.kind == MessageKindScreenshotAttempt {
		senderName, senderDisplay, err := s.cachedUserNames(ctx, tx, orgID, senderID)
		if err != nil {
			return nil, err
		}
		body = screenshotAttemptBody(senderDisplay, senderName)
	}
	if opts.kind == MessageKindAttachmentOpened || opts.kind == MessageKindAttachmentDownloaded {
		if opts.attachmentID == "" {
			return nil, ErrForbidden
		}
		filename, err := s.attachmentForActivity(ctx, tx, orgID, opts.attachmentID, senderID, ScopeConversation, convID)
		if err != nil {
			return nil, err
		}
		senderName, senderDisplay, err := s.cachedUserNames(ctx, tx, orgID, senderID)
		if err != nil {
			return nil, err
		}
		body = attachmentActionBody(opts.kind, senderDisplay, senderName, filename)
	}

	msgID := opts.messageID
	if msgID == "" {
		msgID = uuid.Must(uuid.NewV7()).String()
	}

	// Resolve (or, for a top-level send, lock the conversation for) the
	// thread BEFORE checking idempotency — not after, as this used to. Two
	// reasons, one per case below:
	//
	//   - A reply's thread has to be known before the check runs because the
	//     UNIQUE constraint this check stands in for is keyed on thread_id.
	//     Checking without it can match an EARLIER message in a DIFFERENT
	//     thread that happens to share this sender+clientMsgId, and silently
	//     hand back that unrelated message's id instead of ever creating the
	//     one this call was actually asked to send.
	//
	//   - A top-level send has no thread yet — one is about to be created —
	//     so locking the conversation (lockConversationForRootSend) is what
	//     has to happen before the check instead: two concurrent sends of the
	//     same brand-new clientMsgId used to both pass the check unlocked,
	//     then each mint its OWN fresh thread once it in turn got the lock
	//     ensureThread took only at that later point — different thread ids,
	//     so the (correctly thread_id-aware) UNIQUE constraint never caught
	//     it either. Locking first serializes them: the loser's check, now
	//     running after the winner has committed, finds the winner's row.
	var (
		threadID  string
		parentArg *string
		origin    = opts.origin
	)
	switch {
	case parentMessageID != "":
		// Reply with explicit parent — inherit parent's thread.
		var err error
		threadID, _, _, err = resolveThreadForReply(ctx, tx, convID, parentMessageID)
		if err != nil {
			return nil, err
		}
		parentArg = &parentMessageID
	case threadIDHint != "":
		// Server-chosen thread (legacy reply with no parent).
		threadID = threadIDHint
	default:
		// Top-level. threadID stays "" — a genuinely new send creates one
		// further down, once the idempotency check below confirms this is
		// not a retry.
		if err := lockConversationForRootSend(ctx, tx, convID, orgID); err != nil {
			return nil, err
		}
	}

	// Idempotency. threadID is either resolved (a reply) or intentionally
	// still empty (a top-level send, whose conversation is now locked above)
	// — never checked before one of those two is true, per the comment above.
	// The pre-check is cheaper than catching the unique-violation, and
	// importantly the second-write rollback would lose the inbox_items
	// upserts.
	idemptQuery := `SELECT id, seq, thread_id FROM messages
		 WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`
	idemptArgs := []any{convID, senderID, clientMsgID}
	if threadID != "" {
		idemptQuery += ` AND thread_id = $4`
		idemptArgs = append(idemptArgs, threadID)
	}
	var existingID string
	var existingSeq int64
	var existingThread *string
	err := tx.QueryRow(ctx, idemptQuery, idemptArgs...).Scan(&existingID, &existingSeq, &existingThread)
	if err == nil {
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

	isThreadRoot := threadID == ""
	if isThreadRoot {
		// ensureThread re-takes the same lock acquired above — a harmless
		// no-op re-entrant lock within one transaction — and actually
		// creates the thread now that this is confirmed to be new.
		threadID, err = s.ensureThread(ctx, tx, orgID, convID, msgID, senderID, recipientID, body, origin)
		if err != nil {
			return nil, err
		}
	}

	// A reply lives in whatever kind of thread it joined; only a NEW thread gets
	// to declare one. Reading it back (rather than trusting opts) is what stops a
	// chat reply from smuggling itself into the Inbox by claiming origin=mail.
	if !isThreadRoot {
		if err = tx.QueryRow(ctx,
			`SELECT origin FROM threads WHERE id = $1`, threadID).Scan(&origin); err != nil {
			return nil, err
		}
	}

	// Encrypt the body under the org DEK (created lazily in THIS tx). The
	// plaintext column is left NULL — body_enc is the source of truth.
	bodyEnc, err := s.crypto.Encrypt(ctx, tx, orgID, body)
	if err != nil {
		return nil, err
	}
	// reply_to_id is DISTINCT from parent_message_id: the latter is Gmail-style
	// threading (it decides which thread a message joins), the former is "this
	// bubble quotes that bubble". Overloading one for the other would reshape
	// the Inbox thread tree every time someone replied in chat.
	var replyToArg *string
	if opts.replyToID != "" {
		replyToArg = &opts.replyToID
	}
	var forwardedFromArg *string
	if opts.forwardedFrom != "" {
		forwardedFromArg = &opts.forwardedFrom
	}
	var forwardPlatformArg *string
	if opts.forwardPlatform != "" {
		forwardPlatformArg = &opts.forwardPlatform
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO messages
		   (id, org_id, conversation_id, seq, sender_id, body, body_enc, client_msg_id,
		    thread_id, parent_message_id, is_thread_root, server_acked_at,
		    kind, reply_to_id, is_forward, forwarded_from_message_id, forward_platform)
		 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15)`,
		msgID, orgID, convID, seq, senderID, bodyEnc, clientMsgID,
		threadID, parentArg, isThreadRoot,
		opts.kindArg(), replyToArg, opts.isForward, forwardedFromArg, forwardPlatformArg)
	if err != nil {
		return nil, err
	}

	// Always bump the thread so last_message_seq reflects this insert. For the
	// root message the thread row's DEFAULT 0 last_message_seq would otherwise
	// linger until the first reply, leaving GetThread reporting a stale seq.
	if err := bumpThread(ctx, tx, threadID, seq); err != nil {
		return nil, err
	}

	// Inbox projection — MAIL THREADS ONLY.
	//
	// This is the whole "chat is showing up in my Inbox" fix. Every message used
	// to write these two rows, so /inbox/peers summed chat unread into the rail
	// badge and listed DM-only peers in the People sidebar, whose feed then
	// rendered empty because the feed itself filtered them back out.
	//
	// Same tx, with a monotonic last_event_at guard. The sender's row never
	// bumps unread (it is their own send); the recipient's gets +1.
	preview := truncatePreview(body)
	if origin == ThreadOriginMail {
		now := time.Now().UTC()
		if err := s.upsertThreadInboxItem(ctx, tx, orgID, senderID, threadID, recipientID, preview, "SENT", now, 0); err != nil {
			return nil, err
		}
		if err := s.upsertThreadInboxItem(ctx, tx, orgID, recipientID, threadID, senderID, preview, "", now, 1); err != nil {
			return nil, err
		}
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
		// The consumer needs this for the same reason appendMessage does: the
		// client optimistically inserts an inbox row on MessageCreated, and
		// without the origin it would put back exactly the rows we stopped
		// writing above.
		Origin:          origin,
		ReplyToID:       opts.replyToID,
		IsForward:       opts.isForward,
		ForwardPlatform: opts.forwardPlatform,
	}
	if err := insertOutbox(ctx, tx, convID, evt); err != nil {
		return nil, err
	}

	return &SendResult{
		ConversationID: convID,
		ThreadID:       threadID,
		MessageID:      msgID,
		Seq:            seq,
	}, nil
}
