package store

import (
	"context"
	"errors"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The in-channel notice a PRIVATE (locked) channel gets when something that
// originated in it is forwarded: "<Forwarder> forwarded a message from this
// channel".
//
// What it is for: a locked channel is invite-only, so its members decided who
// may read it. A forward carries that content to people they never chose, and
// the members are entitled to know it happened — even though they are not
// entitled to know where it went.
//
// What it must never say. The body is the forwarder's name and nothing else, and
// the ChannelMessageCreated event it rides carries only that body and the
// channel's own roster. The destination (user, chat or channel), the number of
// destinations and the number of messages are all absent on purpose: the
// message_forwards edge, which is RLS-scoped and routed only to the forwarder
// and the original author, remains the single place that knows them.
//
// "Originated" means the ROOT of the forward chain, not the message in hand. A
// clone forwarded out of a DM still traces back to a locked channel through
// message_forwards.root_message_id, and that channel is the one that is told.
// An intermediate DM or open channel is never notified.
//
// The notice is written on the forward's own transaction, so it exists exactly
// when a forward does, and it is idempotent on a key derived from the request's
// own client id (see derivedForwardNoticeID).

// forwardNoticeNamespace is the fixed UUIDv5 namespace the notice's client_msg_id
// is derived under. NEVER CHANGE IT — the derived id is the only thing keeping a
// retried forward from posting its notice a second time.
var forwardNoticeNamespace = uuid.MustParse("c0a5a8d4-6a37-4a0e-9d4e-5b7d6a3f2e91")

// resolveForwardNoticeChannel returns the id of the LOCKED channel the chain
// rooted at rootMessageID originated in, or "" when the root is a DM message,
// lives in an open channel, or its channel no longer exists (deleting a channel
// deletes its messages, so there is nobody left to notify).
//
// Deliberately not filtered by deleted_for_all_at: a root that was later unsent
// is still the origin of everything cloned from it.
func resolveForwardNoticeChannel(ctx context.Context, tx pgx.Tx, rootMessageID string) (string, error) {
	var channelID string
	err := tx.QueryRow(ctx,
		`SELECT m.channel_id::text
		   FROM channel_messages m
		   JOIN channels c ON c.id = m.channel_id
		  WHERE m.id = $1 AND c.is_locked`, rootMessageID).Scan(&channelID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return channelID, nil
}

// derivedForwardNoticeID is the notice's client_msg_id: one per (request,
// private channel). requestKey is "forward:"+clientMsgId for a single forward and
// "batch:"+clientBatchId for a batch, so the same id can never mean both.
func derivedForwardNoticeID(requestKey, channelID string) string {
	return uuid.NewSHA1(forwardNoticeNamespace, []byte(requestKey+"|"+channelID)).String()
}

// channelID is the channel a target delivers into, "" for a user's 1:1 chat.
func (t ForwardTarget) channelID() string {
	if t.Kind == ForwardTargetChannel {
		return t.ID
	}
	return ""
}

// writeForwardNotices posts one notice into each distinct locked channel the
// given sources originated in, except destChannelID: forwarding a message into
// the very channel it came from reveals nothing that channel cannot already see.
//
// Call it on the transaction that has just written the forward, after the clone
// and its provenance edge — never before, never for a forward that was refused.
// Does NOT commit. Channels are visited in sorted order so two concurrent
// batches touching the same pair of channels lock them in the same order rather
// than deadlocking.
//
// Re-running it for the same requestKey is a no-op: appendChannelMessageTx
// dedupes on (channel, sender, client_msg_id) and returns the existing row.
func (s *Store) writeForwardNotices(
	ctx context.Context, tx pgx.Tx, orgID, forwarderID, destChannelID, requestKey string,
	fcs ...*ForwardSourceCtx,
) error {
	seen := make(map[string]struct{}, len(fcs))
	channels := make([]string, 0, len(fcs))
	for _, fc := range fcs {
		id := fc.NoticeChannelID
		if id == "" || id == destChannelID {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		channels = append(channels, id)
	}
	if len(channels) == 0 {
		return nil
	}
	sort.Strings(channels)

	// The name comes from the projection, never from the request: this body is
	// rendered as an authoritative-looking system pill, so client-supplied text
	// would let any member forge one (see screenshotAttemptBody).
	uname, display, err := s.cachedUserNames(ctx, tx, orgID, forwarderID)
	if err != nil {
		return err
	}
	body := userDisplayName(display, uname) + " forwarded a message from this channel"

	for _, channelID := range channels {
		if _, err := s.appendChannelMessageTx(ctx, tx, orgID, channelID, forwarderID, body,
			derivedForwardNoticeID(requestKey, channelID),
			channelAppendOpts{kind: MessageKindChannelForwardNotice}); err != nil {
			return err
		}
	}
	return nil
}
