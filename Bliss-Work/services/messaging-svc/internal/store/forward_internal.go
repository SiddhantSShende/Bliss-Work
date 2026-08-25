package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// Forwarding a message to another chat or channel INSIDE the workspace.
//
// The sibling path (forward_link.go) hands a message to WhatsApp and records
// 'unconfirmed' because handing a URL to the operating system ends our
// visibility. This one is the opposite in every respect that matters: the
// message is written to a destination in this database, in one transaction with
// its provenance edge, so it records 'confirmed' and the wording downstream may
// say "forwarded" without overstating anything.
//
// What makes it more than a copy-paste of the body is media. An attachment is
// authorized by the (scope, scope_id) it was uploaded to, so ids copied verbatim
// into another conversation are ids the recipient cannot read. Every forward
// therefore re-scopes the files it carries (forward_attachments.go) and rewrites
// the body to point at the clones.

// Forward destinations.
const (
	ForwardTargetUser    = "user"
	ForwardTargetChannel = "channel"
)

// ForwardTarget is where a forward is going: a person (their 1:1 chat, created
// if this is the first message) or a channel the forwarder belongs to.
type ForwardTarget struct {
	Kind string
	ID   string
}

// Valid reports whether the target names a destination this store can write to.
func (t ForwardTarget) Valid() bool {
	return (t.Kind == ForwardTargetUser || t.Kind == ForwardTargetChannel) && t.ID != ""
}

// ForwardResult is the delivered clone, so the client can navigate to it.
type ForwardResult struct {
	MessageID      string
	ConversationID string
	ChannelID      string
}

// ForwardMessage delivers sourceMessageID to target as a new message from the
// caller, and records the provenance edge.
//
// Idempotent on clientMsgID against the DESTINATION, exactly like an ordinary
// send: a retried request re-uses the message the first attempt wrote rather
// than delivering it twice or writing a second edge.
func (s *Store) ForwardMessage(
	ctx context.Context, orgID, forwarderID, sourceMessageID string,
	target ForwardTarget, clientMsgID string,
) (*ForwardResult, error) {
	if !target.Valid() {
		return nil, ErrForbidden
	}
	// Authorize the SOURCE first, in its own read-only transaction. Identical
	// question to the one the deep-link path asks — may this person read this
	// message, and what chain does it belong to — so it is the same code.
	fc, err := s.ForwardSourceResolve(ctx, orgID, forwarderID, sourceMessageID)
	if err != nil {
		return nil, err
	}

	var out *ForwardResult
	err = RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		var res *ForwardResult
		if target.Kind == ForwardTargetChannel {
			res, err = s.forwardToChannel(ctx, tx, orgID, forwarderID, sourceMessageID, target.ID, clientMsgID, fc)
		} else {
			res, err = s.forwardToUser(ctx, tx, orgID, forwarderID, sourceMessageID, target.ID, clientMsgID, fc)
		}
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

// forwardToUser delivers into the 1:1 conversation between the forwarder and the
// target, creating it if they have never spoken.
//
// The conversation upsert, the block gate and the member revival are the same
// three steps SendMessage performs, and for the same reasons — a forward is an
// ordinary send with a provenance edge attached, not a privileged write that may
// bypass a block.
func (s *Store) forwardToUser(
	ctx context.Context, tx pgx.Tx, orgID, forwarderID, sourceMessageID, targetUserID, clientMsgID string,
	fc *ForwardSourceCtx,
) (*ForwardResult, error) {
	if targetUserID == forwarderID {
		return nil, ErrForbidden
	}
	// The target must belong to this org. Without it a forward is a way to open
	// a conversation with a user id guessed from another org — the upsert below
	// would happily create the row, and RLS would not object because the row
	// carries OUR org_id.
	//
	// Mirrors CreateDirectCall's gate deliberately, down to answering
	// ErrForbidden for an id that does not exist: a forward is an ordinary send
	// with provenance attached, and it must be neither more nor less permissive
	// than starting a chat with the same person.
	var targetOrg string
	err := tx.QueryRow(ctx,
		`SELECT org_id::text FROM user_projection WHERE user_id = $1`, targetUserID).Scan(&targetOrg)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if targetOrg != orgID {
		return nil, ErrForbidden
	}

	low, high := orderedPair(forwarderID, targetUserID)
	convID := uuid.Must(uuid.NewV7()).String()
	if err := tx.QueryRow(ctx,
		`INSERT INTO conversations (id, org_id, user_low, user_high)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (org_id, user_low, user_high) DO UPDATE SET org_id = EXCLUDED.org_id
		 RETURNING id`,
		convID, orgID, low, high).Scan(&convID); err != nil {
		return nil, err
	}

	// A block in EITHER direction closes the conversation to both parties.
	var blocked bool
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(bool_or(blocked), false) FROM conversation_members
		 WHERE conversation_id = $1`, convID).Scan(&blocked); err != nil &&
		!errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if blocked {
		return nil, ErrForbidden
	}

	// Retry of a request that already landed: return the message it wrote. This
	// is checked BEFORE the edge is written, not left to appendMessage's own
	// dedupe, which happens too late to stop a second message_forwards row —
	// the same ordering ForwardLinkRecord relies on.
	var existingID string
	err = tx.QueryRow(ctx,
		`SELECT id::text FROM messages
		  WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
		convID, forwarderID, clientMsgID).Scan(&existingID)
	if err == nil {
		if cerr := tx.Commit(ctx); cerr != nil {
			return nil, cerr
		}
		return &ForwardResult{MessageID: existingID, ConversationID: convID}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	if err := s.upsertMember(ctx, tx, convID, orgID, forwarderID); err != nil {
		return nil, err
	}
	if err := s.upsertMember(ctx, tx, convID, orgID, targetUserID); err != nil {
		return nil, err
	}

	body, err := s.rescopeForwardBody(ctx, tx, orgID, forwarderID, ScopeConversation, convID, fc.Body)
	if err != nil {
		return nil, err
	}

	// The clone's id is minted HERE rather than inside appendMessage because the
	// provenance edge references it and must be written on the same transaction —
	// and appendMessage owns the COMMIT, so nothing may be written after it.
	cloneID := uuid.Must(uuid.NewV7()).String()
	if err := s.recordInternalForward(ctx, tx, orgID, forwarderID, sourceMessageID, cloneID,
		targetUserID, "", convID, body, fc); err != nil {
		return nil, err
	}

	res, err := s.appendMessage(ctx, tx, orgID, convID, forwarderID, targetUserID,
		body, clientMsgID, "", "",
		appendOpts{messageID: cloneID, isForward: true, forwardedFrom: sourceMessageID})
	if err != nil {
		return nil, err
	}
	return &ForwardResult{MessageID: res.MessageID, ConversationID: convID}, nil
}

// forwardToChannel delivers into a channel the forwarder belongs to.
func (s *Store) forwardToChannel(
	ctx context.Context, tx pgx.Tx, orgID, forwarderID, sourceMessageID, channelID, clientMsgID string,
	fc *ForwardSourceCtx,
) (*ForwardResult, error) {
	if err := requireChannelMember(ctx, tx, orgID, channelID, forwarderID); err != nil {
		return nil, err
	}
	// A block without a kick is a mute: still reading, not posting. A forward is
	// a post.
	if blocked, err := isBlocked(ctx, tx, channelID, forwarderID); err != nil {
		return nil, err
	} else if blocked {
		return nil, ErrForbidden
	}

	var existingID string
	err := tx.QueryRow(ctx,
		`SELECT id::text FROM channel_messages
		  WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
		channelID, forwarderID, clientMsgID).Scan(&existingID)
	if err == nil {
		if cerr := tx.Commit(ctx); cerr != nil {
			return nil, cerr
		}
		return &ForwardResult{MessageID: existingID, ChannelID: channelID}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	body, err := s.rescopeForwardBody(ctx, tx, orgID, forwarderID, ScopeChannel, channelID, fc.Body)
	if err != nil {
		return nil, err
	}

	cloneID := uuid.Must(uuid.NewV7()).String()
	if err := s.recordInternalForward(ctx, tx, orgID, forwarderID, sourceMessageID, cloneID,
		"", channelID, "", body, fc); err != nil {
		return nil, err
	}
	if _, err := s.appendChannelMessageTx(ctx, tx, orgID, channelID, forwarderID, body, clientMsgID,
		channelAppendOpts{messageID: cloneID, isForward: true, forwardedFrom: sourceMessageID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ForwardResult{MessageID: cloneID, ChannelID: channelID}, nil
}

// rescopeForwardBody clones whatever files the body references into the
// destination and returns the body rewritten to point at them. Plain text and
// shared locations are self-contained and come back unchanged.
func (s *Store) rescopeForwardBody(
	ctx context.Context, tx pgx.Tx, orgID, forwarderID, scope, scopeID, body string,
) (string, error) {
	ids := mediaAttachmentIDs(body)
	if len(ids) == 0 {
		return body, nil
	}
	remap, err := s.cloneAttachmentsInto(ctx, tx, orgID, forwarderID, scope, scopeID, ids)
	if err != nil {
		return "", err
	}
	rewritten, _ := rewriteMediaAttachmentIDs(body, remap)
	return rewritten, nil
}

// chainPath is root..clone: the chain this hop extends, with the new message on
// the end. Copied rather than appended in place — fc.Path is the caller's slice
// and a forward that quietly rewrote it would corrupt the next hop's cycle
// guard.
func chainPath(path []string, cloneID string) []string {
	out := make([]string, 0, len(path)+1)
	out = append(out, path...)
	return append(out, cloneID)
}

// recordInternalForward writes the provenance edge and the message.forwarded
// event. Exactly one of targetUserID / targetChannelID is set.
//
// The edge is what lets the ORIGINAL author see where their message went, so it
// references the ROOT of the chain rather than the message that happened to be
// forwarded — a forward of a forward still points home.
func (s *Store) recordInternalForward(
	ctx context.Context, tx pgx.Tx, orgID, forwarderID, sourceMessageID, cloneID,
	targetUserID, targetChannelID, targetConvID, body string, fc *ForwardSourceCtx,
) error {
	var (
		toUser    *string
		toChannel *string
	)
	if targetUserID != "" {
		toUser = &targetUserID
	}
	if targetChannelID != "" {
		toChannel = &targetChannelID
	}
	var sourceChannel *string
	if fc.Scope == scopeChannel {
		sourceChannel = &fc.ChannelID
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO message_forwards
		   (id, org_id, root_message_id, root_author_id, parent_message_id,
		    forwarded_message_id, forwarded_by, forwarded_to, forwarded_to_channel_id,
		    forwarded_to_external, platform, delivery, channel_id, depth, path)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'blisswork', 'confirmed',
		         $10, $11, $12::uuid[])`,
		uuid.Must(uuid.NewV7()).String(), orgID, fc.RootMessageID, fc.RootAuthorID,
		sourceMessageID, cloneID, forwarderID, toUser, toChannel,
		sourceChannel, fc.Depth, chainPath(fc.Path, cloneID)); err != nil {
		return err
	}

	evt := events.MessageForwarded{
		Type:                 events.TypeMessageForwarded,
		EventID:              uuid.Must(uuid.NewV7()).String(),
		OrgID:                orgID,
		OccurredAt:           nowISO(),
		ConversationID:       fc.ConversationID,
		ChannelID:            fc.ChannelID,
		RootMessageID:        fc.RootMessageID,
		RootAuthorID:         fc.RootAuthorID,
		ParentMessageID:      sourceMessageID,
		ForwardedMessageID:   cloneID,
		ForwardedBy:          forwarderID,
		ForwardedTo:          targetUserID,
		ForwardedToChannelID: targetChannelID,
		Platform:             "blisswork",
		Delivery:             "confirmed",
		Depth:                fc.Depth,
		BodyPreview:          truncatePreview(body),
	}
	// Keyed by the SOURCE surface, like the deep-link path: provenance must not
	// overtake the message it describes, and the message being described is the
	// original, not the clone.
	key := fc.ConversationID
	if fc.Scope == scopeChannel {
		key = fc.ChannelID
	}
	if key == "" {
		key = targetConvID
	}
	if err := insertOutbox(ctx, tx, key, evt); err != nil {
		return fmt.Errorf("forward outbox: %w", err)
	}
	return nil
}
