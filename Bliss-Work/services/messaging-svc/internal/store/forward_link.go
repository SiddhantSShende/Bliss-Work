package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Deep-link forwarding ("open WhatsApp with this message prefilled").
//
// One of the two forward paths. The other (forward_internal.go) delivers to a
// chat or channel inside the workspace and can therefore say a message really
// arrived; this one leaves the org entirely and cannot. The outbound send
// through a connected WhatsApp Business account stays removed — this needs no
// connected account at all, because the message is handed to whatever WhatsApp
// the user already has.
//
// The price is that a deep link is UNVERIFIABLE. The removed Business path only
// recorded a forward once Meta had acknowledged it, so the original author saw
// forwards that really left. Handing a URL to the operating system ends our
// visibility — the user may never press send, may switch contacts inside
// WhatsApp, or may cancel. Everything below therefore records delivery
// 'unconfirmed' and words the system entry as "opened WhatsApp to forward",
// never "forwarded". Do not let that wording drift: it is the only thing
// keeping the audit trail honest about what it actually witnessed.
//
// Unlike the removed relay, this accepts a message from a CHANNEL as well as a
// DM.

// maxForwardDepth caps a forward chain so a runaway A→B→A→B loop can't grow the
// provenance path without bound.
const maxForwardDepth = 20

// forwardScope is where the message being forwarded lives. It decides which
// table the system entry is written to and how much of the recipient's contact
// detail that entry may disclose.
type forwardScope string

const (
	scopeDM      forwardScope = "dm"
	scopeChannel forwardScope = "channel"
)

// ForwardSourceCtx is the resolved provenance of the message being forwarded:
// everything either forward path needs, read in one authorizing pass. Both use
// it — the deep link (ForwardLinkRecord) and the internal forward
// (ForwardMessage) — because "may this person read this message, and what chain
// does it belong to" is the same question whichever way the message then goes.
type ForwardSourceCtx struct {
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

// ForwardSourceResolve authorizes the caller against the source message and
// resolves the chain it belongs to. Read-only, and deliberately separate from
// the write: the deep-link path opens WhatsApp only once ForwardLinkRecord has
// committed, and the internal path needs this answer before it can decide which
// destination transaction to open.
//
// A message id is looked for in `messages` first and `channel_messages` second.
// Both are UUIDv7 from the same generator so they never collide, and a caller
// who can see neither is told the same thing either way (ErrForbidden, not
// ErrNotFound — existence of a message id is itself information).
func (s *Store) ForwardSourceResolve(ctx context.Context, orgID, forwarderID, sourceMessageID string) (*ForwardSourceCtx, error) {
	out := &ForwardSourceCtx{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		srcSender, err := s.resolveForwardSource(ctx, tx, orgID, forwarderID, sourceMessageID, out)
		if err != nil {
			return err
		}
		return resolveForwardProvenance(ctx, tx, sourceMessageID, srcSender, out)
	})
	if err != nil {
		return nil, err
	}
	if out.Depth > maxForwardDepth {
		return nil, ErrForbidden
	}
	return out, nil
}

// resolveForwardSource loads and authorizes the source message from whichever
// table holds it, filling Scope/Body and the scope-specific ids. Returns the
// sender, which is the root author when the message is an original.
func (s *Store) resolveForwardSource(ctx context.Context, tx pgx.Tx, orgID, forwarderID, sourceMessageID string, out *ForwardSourceCtx) (string, error) {
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

// resolveForwardProvenance finds the root of the chain this message belongs to, so
// the edge points at the ORIGINAL author however many hops back that is.
func resolveForwardProvenance(ctx context.Context, tx pgx.Tx, sourceMessageID, srcSender string, out *ForwardSourceCtx) error {
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
// The wording is deliberately weak: we know the link was built and opened, not
// that anything was sent.
//
// USUAL CASE — no recipient. The link carries no number, so WhatsApp shows its
// own contact chooser and whoever was picked is never reported back to us. The
// pill says only that the message left towards WhatsApp. Naming a recipient here
// would be invention, and this pill is the original author's evidence that their
// message left the workspace — the one place a guess is least acceptable.
//
// When a number IS known, it appears in a DM and not in a channel. A DM has
// exactly two readers: the forwarder and the author of the message that left. A
// channel can have dozens, and publishing a third party's phone number to all of
// them is not something that third party agreed to. The number stays on the
// message_forwards edge either way, which is RLS-scoped.
func linkPillBody(scope forwardScope, name, phone string) string {
	if phone == "" && name == "" {
		return "Opened WhatsApp to forward this message"
	}
	if name == "" {
		if scope == scopeDM {
			return fmt.Sprintf("Opened WhatsApp to forward this to +%s", phone)
		}
		return "Opened WhatsApp to forward this to a WhatsApp contact"
	}
	if scope == scopeDM && phone != "" {
		return fmt.Sprintf("Opened WhatsApp to forward this to %s (+%s)", name, phone)
	}
	return "Opened WhatsApp to forward this to " + name
}
