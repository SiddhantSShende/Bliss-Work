package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Deep-link forwarding ("open WhatsApp with this message prefilled").
//
// This is the sibling of forwards.go's ForwardExternalResolve/Record, and the
// difference is what we are allowed to claim afterwards. That path sends through
// integrations-svc and only records once the provider acknowledged, so the
// original author sees forwards that actually left. A wa.me link hands the
// message to the operating system and ends our visibility: the user may never
// press send. Everything below therefore records delivery 'unconfirmed' and
// words the system entry as "opened WhatsApp to forward", never "forwarded".
//
// The other difference is reach: this works with no connected WhatsApp Business
// account, so it is available to every org, and it accepts a message from a
// CHANNEL as well as a DM (which forwards.go does not).

// forwardScope is where the message being forwarded lives. It decides which
// table the system entry is written to and how much of the recipient's contact
// detail that entry may disclose.
type forwardScope string

const (
	scopeDM      forwardScope = "dm"
	scopeChannel forwardScope = "channel"
)

// LinkForwardCtx is the resolved provenance of a deep-link forward: everything
// ForwardLinkRecord needs, read in one authorizing pass.
type LinkForwardCtx struct {
	Scope forwardScope
	Body  string

	// DM sources. OtherUserID is the conversation's other participant — the
	// recipient of the system entry. ThreadID is the source message's thread,
	// passed to appendMessage as a hint so the pill joins the thread it is
	// about instead of opening a new one in the inbox.
	ConversationID string
	OtherUserID    string
	ThreadID       string

	// Channel sources.
	ChannelID string

	RootMessageID string
	RootAuthorID  string
	Depth         int
	Path          []string
}

// LinkForwardResult is what the handler echoes back to the client.
type LinkForwardResult struct {
	SystemMessageID string
	TargetPhone     string
}

// ForwardLinkResolve authorizes the caller against the source message and
// resolves the chain it belongs to. Read-only: the caller opens WhatsApp only
// after ForwardLinkRecord has committed, so the two steps stay separate for the
// same reason ForwardExternalResolve/Record do.
//
// A message id is looked for in `messages` first and `channel_messages` second.
// Both are UUIDv7 from the same generator so they never collide, and a caller
// who can see neither is told the same thing either way (ErrForbidden, not
// ErrNotFound — existence of a message id is itself information).
func (s *Store) ForwardLinkResolve(ctx context.Context, orgID, forwarderID, sourceMessageID string) (*LinkForwardCtx, error) {
	out := &LinkForwardCtx{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		srcSender, err := s.resolveLinkSource(ctx, tx, orgID, forwarderID, sourceMessageID, out)
		if err != nil {
			return err
		}
		return resolveLinkProvenance(ctx, tx, sourceMessageID, srcSender, out)
	})
	if err != nil {
		return nil, err
	}
	if out.Depth > maxForwardDepth {
		return nil, ErrForbidden
	}
	return out, nil
}

// resolveLinkSource loads and authorizes the source message from whichever table
// holds it, filling Scope/Body and the scope-specific ids. Returns the sender,
// which is the root author when the message is an original.
func (s *Store) resolveLinkSource(ctx context.Context, tx pgx.Tx, orgID, forwarderID, sourceMessageID string, out *LinkForwardCtx) (string, error) {
	var (
		sender  string
		body    *string
		bodyEnc []byte
		low     string
		high    string
	)
	var threadID *string
	err := tx.QueryRow(ctx,
		`SELECT m.sender_id::text, m.body, m.body_enc, m.conversation_id::text,
		        m.thread_id::text, c.user_low::text, c.user_high::text
		   FROM messages m
		   JOIN conversations c ON c.id = m.conversation_id
		  WHERE m.id = $1`, sourceMessageID).
		Scan(&sender, &body, &bodyEnc, &out.ConversationID, &threadID, &low, &high)
	switch {
	case err == nil:
		if forwarderID != low && forwarderID != high {
			return "", ErrForbidden
		}
		out.Scope = scopeDM
		out.OtherUserID = low
		if forwarderID == low {
			out.OtherUserID = high
		}
		// Nullable for rows written before the threading migration; an empty
		// hint makes appendMessage open a new thread, which is the right
		// fallback for a message that never belonged to one.
		if threadID != nil {
			out.ThreadID = *threadID
		}
	case errors.Is(err, pgx.ErrNoRows):
		e := tx.QueryRow(ctx,
			`SELECT sender_id::text, body, body_enc, channel_id::text
			   FROM channel_messages WHERE id = $1`, sourceMessageID).
			Scan(&sender, &body, &bodyEnc, &out.ChannelID)
		if errors.Is(e, pgx.ErrNoRows) {
			return "", ErrForbidden
		}
		if e != nil {
			return "", e
		}
		// Membership is the read gate for a channel message; a blocked member
		// may still read (a block is a mute), so isBlocked is not consulted.
		if e := requireChannelMember(ctx, tx, orgID, out.ChannelID, forwarderID); e != nil {
			return "", e
		}
		out.Scope = scopeChannel
	default:
		return "", err
	}

	// body_enc is the source of truth; the plaintext column is the pre-0006
	// fallback for rows written before column encryption.
	if bodyEnc != nil {
		decrypted, derr := s.crypto.Decrypt(ctx, tx, orgID, bodyEnc)
		if derr != nil {
			return "", derr
		}
		out.Body = decrypted
	} else if body != nil {
		out.Body = *body
	}
	return sender, nil
}

// resolveLinkProvenance finds the root of the chain this message belongs to, so
// the edge points at the ORIGINAL author however many hops back that is.
func resolveLinkProvenance(ctx context.Context, tx pgx.Tx, sourceMessageID, srcSender string, out *LinkForwardCtx) error {
	var srcDepth int
	err := tx.QueryRow(ctx,
		`SELECT root_message_id::text, root_author_id::text, depth, path::text[]
		   FROM message_forwards WHERE forwarded_message_id = $1`, sourceMessageID).
		Scan(&out.RootMessageID, &out.RootAuthorID, &srcDepth, &out.Path)
	if errors.Is(err, pgx.ErrNoRows) {
		// Not a clone — this message is the root of its own chain.
		out.RootMessageID = sourceMessageID
		out.RootAuthorID = srcSender
		srcDepth = 0
		out.Path = []string{sourceMessageID}
	} else if err != nil {
		return err
	}
	out.Depth = srcDepth + 1
	return nil
}

// linkPillBody is the text of the system entry written into the origin chat.
//
// The wording is deliberately weaker than the confirmed path's: we know the deep
// link was built and opened, not that anything was sent.
//
// The phone number appears in a DM and not in a channel. A DM has exactly two
// readers — the person who did the forwarding and (in the case this feature
// exists for) the author of the message that left. A channel can have dozens,
// and publishing a third party's phone number to all of them is not something
// that third party agreed to. The full number is still recorded on the
// message_forwards edge, which is RLS-scoped and readable only through the
// forwarding-activity API.
func linkPillBody(scope forwardScope, name, phone string) string {
	who := name
	if who == "" {
		who = "a WhatsApp contact"
		if scope == scopeDM {
			return fmt.Sprintf("Opened WhatsApp to forward this to +%s", phone)
		}
		return "Opened WhatsApp to forward this to " + who
	}
	if scope == scopeDM {
		return fmt.Sprintf("Opened WhatsApp to forward this to %s (+%s)", who, phone)
	}
	return "Opened WhatsApp to forward this to " + who
}
