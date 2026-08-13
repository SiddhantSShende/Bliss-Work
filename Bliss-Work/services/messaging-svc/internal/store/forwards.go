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

// maxForwardDepth caps a forward chain so a runaway A→B→A→B loop can't grow the
// provenance path without bound.
const maxForwardDepth = 20

// appendOpts carries optional forward-tracking context into appendMessage. The
// zero value is a normal (non-forward) message — SendMessage/Reply pass it.
type appendOpts struct {
	forward *forwardInfo
	// kind is the messages.kind value ("" → 'text'). System entries such as
	// MessageKindCallMissed set it; it is never taken from raw client input.
	kind string
	// origin is the surface starting a NEW thread — ThreadOriginChat unless
	// Compose asked for mail. Ignored on a reply, which inherits the thread's.
	origin string
	// replyToID quotes another message in the same conversation ("" → none).
	replyToID string
}

// kindArg is the messages.kind value to insert — 'text' unless a system kind
// was requested, so every existing call site keeps its current behavior.
func (o appendOpts) kindArg() string {
	if o.kind == "" {
		return MessageKindText
	}
	return o.kind
}

// forwardInfo is the provenance ForwardMessage resolves BEFORE cloning, so
// appendMessage can record the message_forwards edge and emit message.forwarded
// in the same tx as the clone (all-or-nothing).
type forwardInfo struct {
	rootMessageID   string   // the ORIGINAL message at the top of the chain
	rootAuthorID    string   // its author — the user who is notified
	parentMessageID string   // the message forwarded on THIS hop (= source id)
	forwardedBy     string   // the user performing the forward
	depth           int      // this hop's depth (1 = first forward of an original)
	path            []string // root..parent chain; appendMessage appends the new clone id
	platform        string   // 'blisswork' for the internal relay
}

func (o appendOpts) isForwardMsg() bool { return o.forward != nil }

// forwardedFromArg is the messages.forwarded_from_message_id value: the source
// message id for a forward, or NULL for a normal message.
func (o appendOpts) forwardedFromArg() *string {
	if o.forward == nil {
		return nil
	}
	src := o.forward.parentMessageID
	return &src
}

// ForwardEdgeDTO is one hop of a forward chain, returned by ListForwards so the
// original author can render the downstream tree.
type ForwardEdgeDTO struct {
	ID                  string  `json:"id"`
	RootMessageID       string  `json:"rootMessageId"`
	RootAuthorID        string  `json:"rootAuthorId"`
	ParentMessageID     string  `json:"parentMessageId"`
	ForwardedMessageID  *string `json:"forwardedMessageId,omitempty"`
	ForwardedBy         string  `json:"forwardedBy"`
	ForwardedTo         *string `json:"forwardedTo,omitempty"`
	ForwardedToExternal *string `json:"forwardedToExternal,omitempty"`
	Platform            string  `json:"platform"`
	Depth               int     `json:"depth"`
	CreatedAt           string  `json:"createdAt"`
	// Delivery is "confirmed" when a provider acknowledged the send, and
	// "unconfirmed" for a deep link. The activity UI renders the two
	// differently — presenting an opened wa.me link the same way as a
	// Graph-API-acknowledged send would undermine the point of this feed.
	Delivery string `json:"delivery"`
	// ForwardedToName is the captured contact's display name, decrypted for
	// the root author. Absent when none was captured.
	ForwardedToName *string `json:"forwardedToName,omitempty"`
	// ChannelID is set when the forwarded message lived in a channel.
	ChannelID *string `json:"channelId,omitempty"`
}

// ForwardMessage clones a message the caller can see into a new 1:1 message
// delivered to recipientID, records a message_forwards provenance edge that
// references the ROOT of the chain, and emits message.forwarded so the ORIGINAL
// author learns their message was forwarded (routed to [C, B, A]). The clone
// rides its own MessageCreated, so the recipient's chat/inbox/badges just work.
//
// Idempotent on (B↔C conversation, forwarderID, clientMsgID) via appendMessage:
// a duplicate forward returns the existing clone and records no second edge.
//
// Phase 1 scope: internal relay only (recipientID is a Bliss-Work user, platform
// 'blisswork'). Outbound-to-external forwards reuse the same edge/event with
// platform set + forwarded_to_external populated (added with the provider layer).
func (s *Store) ForwardMessage(ctx context.Context, orgID, forwarderID, sourceMessageID, recipientID, clientMsgID string) (*SendResult, error) {
	if forwarderID == recipientID {
		return nil, fmt.Errorf("cannot forward to self")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	// Load the source message + its conversation participants. The caller must be
	// a participant of the source conversation to forward it. (Phase 1: 1:1 DM
	// messages only — channel-message forwarding is a later phase.)
	var (
		srcSender  string
		srcBody    *string
		srcBodyEnc []byte
		srcConv    string
		srcLow     string
		srcHigh    string
	)
	err = tx.QueryRow(ctx,
		`SELECT m.sender_id::text, m.body, m.body_enc, m.conversation_id::text,
		        c.user_low::text, c.user_high::text
		   FROM messages m
		   JOIN conversations c ON c.id = m.conversation_id
		  WHERE m.id = $1`, sourceMessageID).
		Scan(&srcSender, &srcBody, &srcBodyEnc, &srcConv, &srcLow, &srcHigh)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if forwarderID != srcLow && forwarderID != srcHigh {
		return nil, ErrForbidden
	}

	// Decrypt the source body (body_enc is the source of truth; the plaintext
	// column is a legacy fallback for pre-encryption rows).
	body := ""
	if srcBodyEnc != nil {
		body, err = s.crypto.Decrypt(ctx, tx, orgID, srcBodyEnc)
		if err != nil {
			return nil, err
		}
	} else if srcBody != nil {
		body = *srcBody
	}

	// Resolve provenance: is the source itself a forwarded clone, or an original?
	var (
		rootMessageID string
		rootAuthorID  string
		srcDepth      int
		srcPath       []string
	)
	err = tx.QueryRow(ctx,
		`SELECT root_message_id::text, root_author_id::text, depth, path::text[]
		   FROM message_forwards WHERE forwarded_message_id = $1`, sourceMessageID).
		Scan(&rootMessageID, &rootAuthorID, &srcDepth, &srcPath)
	if errors.Is(err, pgx.ErrNoRows) {
		// Source is an original message — it is the root of its own chain.
		rootMessageID = sourceMessageID
		rootAuthorID = srcSender
		srcDepth = 0
		srcPath = []string{sourceMessageID}
	} else if err != nil {
		return nil, err
	}

	newDepth := srcDepth + 1
	if newDepth > maxForwardDepth {
		return nil, ErrForbidden
	}

	// Ensure the B↔C conversation exists + is visible, then gate on block state
	// (mirrors SendMessage: neither party can send while EITHER has blocked).
	low, high := orderedPair(forwarderID, recipientID)
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

	if err := s.upsertMember(ctx, tx, convID, orgID, forwarderID); err != nil {
		return nil, err
	}
	if err := s.upsertMember(ctx, tx, convID, orgID, recipientID); err != nil {
		return nil, err
	}

	// Clone the source as a NEW top-level message from B to C, carrying forward
	// provenance. appendMessage inserts the clone + the message_forwards edge +
	// both MessageCreated (for C) and message.forwarded (for A), then commits.
	return s.appendMessage(ctx, tx, orgID, convID, forwarderID, recipientID, body, clientMsgID, "", "",
		appendOpts{forward: &forwardInfo{
			rootMessageID:   rootMessageID,
			rootAuthorID:    rootAuthorID,
			parentMessageID: sourceMessageID,
			forwardedBy:     forwarderID,
			depth:           newDepth,
			path:            srcPath,
			platform:        "blisswork",
		}})
}

// ExternalForwardCtx carries the resolved provenance of an outbound-to-external
// forward between the resolve (read) and record (write) steps, so the external
// send can happen in between without holding a DB transaction open.
type ExternalForwardCtx struct {
	Body           string
	ConversationID string
	RootMessageID  string
	RootAuthorID   string
	Depth          int
	Path           []string
}

// ForwardExternalResolve validates the caller can forward the source message and
// resolves its provenance, so the caller can send it out via a connected external
// platform. Read-only.
func (s *Store) ForwardExternalResolve(ctx context.Context, orgID, forwarderID, sourceMessageID string) (*ExternalForwardCtx, error) {
	out := &ExternalForwardCtx{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var (
			srcSender  string
			srcBody    *string
			srcBodyEnc []byte
			srcConv    string
			srcLow     string
			srcHigh    string
		)
		e := tx.QueryRow(ctx,
			`SELECT m.sender_id::text, m.body, m.body_enc, m.conversation_id::text,
			        c.user_low::text, c.user_high::text
			   FROM messages m
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE m.id = $1`, sourceMessageID).
			Scan(&srcSender, &srcBody, &srcBodyEnc, &srcConv, &srcLow, &srcHigh)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		if forwarderID != srcLow && forwarderID != srcHigh {
			return ErrForbidden
		}
		body := ""
		if srcBodyEnc != nil {
			body, e = s.crypto.Decrypt(ctx, tx, orgID, srcBodyEnc)
			if e != nil {
				return e
			}
		} else if srcBody != nil {
			body = *srcBody
		}
		var (
			root, rootAuthor string
			srcDepth         int
			srcPath          []string
		)
		e = tx.QueryRow(ctx,
			`SELECT root_message_id::text, root_author_id::text, depth, path::text[]
			   FROM message_forwards WHERE forwarded_message_id = $1`, sourceMessageID).
			Scan(&root, &rootAuthor, &srcDepth, &srcPath)
		if errors.Is(e, pgx.ErrNoRows) {
			root = sourceMessageID
			rootAuthor = srcSender
			srcDepth = 0
			srcPath = []string{sourceMessageID}
		} else if e != nil {
			return e
		}
		out.Body = body
		out.ConversationID = srcConv
		out.RootMessageID = root
		out.RootAuthorID = rootAuthor
		out.Depth = srcDepth + 1
		out.Path = srcPath
		return nil
	})
	if err != nil {
		return nil, err
	}
	if out.Depth > maxForwardDepth {
		return nil, ErrForbidden
	}
	return out, nil
}

// ForwardExternalRecord records the provenance edge + emits message.forwarded for
// an outbound-to-external forward (no Bliss-Work clone exists). Called AFTER the
// external platform has accepted the message, so the author only sees forwards
// that actually left. platform must be one of the message_forwards CHECK values.
func (s *Store) ForwardExternalRecord(ctx context.Context, orgID, forwarderID, sourceMessageID, target, platform string, fc *ExternalForwardCtx) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO message_forwards
		   (id, org_id, root_message_id, root_author_id, parent_message_id,
		    forwarded_message_id, forwarded_by, forwarded_to, forwarded_to_external,
		    platform, depth, path)
		 VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, $7, $8, $9, $10::uuid[])`,
		uuid.Must(uuid.NewV7()).String(), orgID, fc.RootMessageID, fc.RootAuthorID,
		sourceMessageID, forwarderID, target, platform, fc.Depth, fc.Path); err != nil {
		return err
	}
	evt := events.MessageForwarded{
		Type:                events.TypeMessageForwarded,
		EventID:             uuid.Must(uuid.NewV7()).String(),
		OrgID:               orgID,
		OccurredAt:          nowISO(),
		ConversationID:      fc.ConversationID,
		RootMessageID:       fc.RootMessageID,
		RootAuthorID:        fc.RootAuthorID,
		ParentMessageID:     sourceMessageID,
		ForwardedBy:         forwarderID,
		ForwardedToExternal: target,
		Platform:            platform,
		Depth:               fc.Depth,
		BodyPreview:         truncatePreview(fc.Body),
		// Explicit rather than left to the column default: this path is only
		// reached after the provider accepted the message, and saying so here
		// keeps it legible next to the deep-link path that cannot.
		Delivery: "confirmed",
	}
	if err := insertOutbox(ctx, tx, fc.ConversationID, evt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListForwards returns every hop of the forward chain rooted at rootMessageID,
// ordered by depth then time — the downstream tree the ORIGINAL author sees.
// Only the root author may read it (it discloses who forwarded their message and
// to whom). A message that was never forwarded returns an empty list.
func (s *Store) ListForwards(ctx context.Context, orgID, callerID, rootMessageID string) ([]ForwardEdgeDTO, error) {
	out := []ForwardEdgeDTO{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT id::text, root_message_id::text, root_author_id::text,
			        parent_message_id::text, forwarded_message_id::text, forwarded_by::text,
			        forwarded_to::text, forwarded_to_external, platform, depth, created_at,
			        delivery, forwarded_to_name_enc, channel_id::text
			   FROM message_forwards
			  WHERE root_message_id = $1
			  ORDER BY depth, created_at`, rootMessageID)
		if err != nil {
			return err
		}
		// Buffer the rows and close the cursor BEFORE decrypting: a Decrypt
		// query issued on this tx while `rows` is still open errors with
		// "conn busy". Same shape as ListMyForwardActivity below — this loop
		// used to stream straight out, and gained the buffer when the contact
		// name became an encrypted column.
		type rawEdge struct {
			e       ForwardEdgeDTO
			created time.Time
			nameEnc []byte
		}
		var raws []rawEdge
		for rows.Next() {
			var r rawEdge
			if err := rows.Scan(&r.e.ID, &r.e.RootMessageID, &r.e.RootAuthorID,
				&r.e.ParentMessageID, &r.e.ForwardedMessageID, &r.e.ForwardedBy,
				&r.e.ForwardedTo, &r.e.ForwardedToExternal, &r.e.Platform, &r.e.Depth,
				&r.created, &r.e.Delivery, &r.nameEnc, &r.e.ChannelID); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range raws {
			e := r.e
			if r.nameEnc != nil {
				name, derr := s.crypto.Decrypt(ctx, tx, orgID, r.nameEnc)
				if derr != nil {
					return derr
				}
				e.ForwardedToName = &name
			}
			e.CreatedAt = r.created.UTC().Format("2006-01-02T15:04:05.000Z")
			out = append(out, e)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Authorization: only the original author may view the forwarding tree. Every
	// row of one root carries the same root_author_id, so the first row decides.
	if len(out) > 0 && out[0].RootAuthorID != callerID {
		return nil, ErrForbidden
	}
	return out, nil
}

// ForwardActivityDTO summarizes one of the caller's original messages that has
// been forwarded: what it said, how many hops so far, and when it was last
// forwarded. Drives the "who forwarded my messages" feed.
type ForwardActivityDTO struct {
	RootMessageID   string `json:"rootMessageId"`
	Preview         string `json:"preview"`
	ForwardCount    int    `json:"forwardCount"`
	LastForwardedAt string `json:"lastForwardedAt"`
	// HasUnconfirmed is true when at least one hop of this message was a deep
	// link we could not verify. It stays a flag rather than splitting
	// ForwardCount in two: the count answers "how far did this travel", which
	// is unchanged, and the flag answers "is any of it unverified", which is
	// what the row needs in order not to overstate itself.
	HasUnconfirmed bool `json:"hasUnconfirmed,omitempty"`
}

// ListMyForwardActivity returns every original message the caller authored that
// has been forwarded at least once, newest activity first. The root body is
// decrypted for a preview (buffered-then-decrypt to respect the pgx "conn busy"
// rule while a cursor is open).
func (s *Store) ListMyForwardActivity(ctx context.Context, orgID, callerID string) ([]ForwardActivityDTO, error) {
	out := []ForwardActivityDTO{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// The root can live in either message table: a DM message, or — since
		// deep-link forwarding — a channel message. Joining only `messages`
		// would leave every channel-rooted row with a blank preview.
		rows, err := tx.Query(ctx,
			`SELECT f.root_message_id::text,
			        COALESCE(m.body, cm.body)         AS body,
			        COALESCE(m.body_enc, cm.body_enc) AS body_enc,
			        count(*) AS forward_count, max(f.created_at) AS last_forwarded_at,
			        bool_or(f.delivery = 'unconfirmed') AS has_unconfirmed
			   FROM message_forwards f
			   LEFT JOIN messages m          ON m.id = f.root_message_id
			   LEFT JOIN channel_messages cm ON cm.id = f.root_message_id
			  WHERE f.root_author_id = $1
			  GROUP BY f.root_message_id, COALESCE(m.body, cm.body),
			           COALESCE(m.body_enc, cm.body_enc)
			  ORDER BY max(f.created_at) DESC`, callerID)
		if err != nil {
			return err
		}
		type raw struct {
			d       ForwardActivityDTO
			body    *string
			bodyEnc []byte
			last    time.Time
		}
		var raws []raw
		for rows.Next() {
			var r raw
			if err := rows.Scan(&r.d.RootMessageID, &r.body, &r.bodyEnc,
				&r.d.ForwardCount, &r.last, &r.d.HasUnconfirmed); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range raws {
			d := r.d
			if r.bodyEnc != nil {
				dec, derr := s.crypto.Decrypt(ctx, tx, orgID, r.bodyEnc)
				if derr != nil {
					return derr
				}
				d.Preview = truncatePreview(dec)
			} else if r.body != nil {
				d.Preview = truncatePreview(*r.body)
			}
			d.LastForwardedAt = r.last.UTC().Format("2006-01-02T15:04:05.000Z")
			out = append(out, d)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
