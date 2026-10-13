package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// upsertMember inserts or revives a conversation member row, restoring visibility.
func (s *Store) upsertMember(ctx context.Context, tx pgx.Tx, convID, orgID, userID string) error {
	_, err := tx.Exec(ctx,
		// visible is unconditionally true: every caller is adding or reviving a
		// member, and hiding goes through Ignore/hidden_at_seq instead.
		`INSERT INTO conversation_members (conversation_id, org_id, user_id, visible)
		 VALUES ($1, $2, $3, true)
		 ON CONFLICT (conversation_id, user_id)
		 DO UPDATE SET visible = true, hidden_at_seq = NULL`,
		convID, orgID, userID)
	return err
}

// ── Open ──────────────────────────────────────────────────────────────────────

// OpenConversation ensures the 1:1 conversation between the caller and the peer
// exists and is visible to the CALLER, without appending a message. Idempotent:
// re-opening an existing conversation returns the same id.
//
// WHY THIS EXISTS. Creating a conversation used to be a side effect of sending
// one — SendMessage's INSERT … ON CONFLICT below was the only path that ever
// wrote a `conversations` row. So every "message this person" button in the app
// fabricated a greeting ("👋 Hi Sam!") purely to make the row appear, and the
// recipient received a message no human had written. This is the same upsert
// minus appendMessage: no seq, no thread, no inbox_items row, no outbox event.
//
// Only the CALLER's member row is upserted, deliberately. Reviving the peer's
// row too would put an empty conversation in their sidebar the moment someone
// opened a chat window — the same unsolicited "you got contacted" signal the
// fake greeting produced. Both rows are upserted on the first real send
// (SendMessage / replyImpl), which is when the peer genuinely has something to
// see.
//
// Blocking is deliberately NOT enforced here: opening the window is harmless,
// and DMView renders the "you blocked this user" notice from the conversation
// DTO. Refusing would produce an error dialog where an explanation belongs.
func (s *Store) OpenConversation(ctx context.Context, orgID, callerID, peerID string) (string, error) {
	if callerID == peerID {
		return "", ErrForbidden
	}
	low, high := orderedPair(callerID, peerID)

	convID := uuid.Must(uuid.NewV7()).String()
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Same gate as SendMessage: a peer id from another org must not get a row.
		if err := requireSameOrgUser(ctx, tx, orgID, peerID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO conversations (id, org_id, user_low, user_high)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (org_id, user_low, user_high) DO UPDATE SET org_id = EXCLUDED.org_id
			 RETURNING id`,
			convID, orgID, low, high).Scan(&convID); err != nil {
			return err
		}
		return s.upsertMember(ctx, tx, convID, orgID, callerID)
	})
	if err != nil {
		return "", err
	}
	return convID, nil
}

// OpenSelfChat ensures the caller's Notes-to-Self conversation exists and is
// visible, without appending a message. Idempotent — same upsert pattern as
// OpenConversation above, deliberately keyed on the self pair (user_low =
// user_high = callerID) that OpenConversation's own `callerID == peerID`
// guard exists to refuse for an ordinary 1:1. That guard protects real DM
// semantics (you cannot open a conversation "with yourself" as a second
// party); this is a different, explicitly-named conversation — the caller's
// own permanent note-taking space — so it gets its own entry point rather
// than widening OpenConversation's.
//
// Only ONE member row is upserted: conversation_members is keyed
// (conversation_id, user_id), and the caller is the only distinct user in a
// self-chat, so there is no second row to revive.
func (s *Store) OpenSelfChat(ctx context.Context, orgID, callerID string) (string, error) {
	convID := uuid.Must(uuid.NewV7()).String()
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO conversations (id, org_id, user_low, user_high)
			 VALUES ($1, $2, $3, $3)
			 ON CONFLICT (org_id, user_low, user_high) DO UPDATE SET org_id = EXCLUDED.org_id
			 RETURNING id`,
			convID, orgID, callerID).Scan(&convID); err != nil {
			return err
		}
		return s.upsertMember(ctx, tx, convID, orgID, callerID)
	})
	if err != nil {
		return "", err
	}
	return convID, nil
}

// ── Ignore ────────────────────────────────────────────────────────────────────

// Ignore hides the conversation for BOTH members and emits conversation.ignored.
func (s *Store) Ignore(ctx context.Context, orgID, callerID, convID string) error {
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

		low, high, seq, err := conversationMembers(ctx, tx, orgID, convID, callerID)
		if err != nil {
			return err
		}

		// Hide BOTH member rows at the current seq (no user filter).
		_, err = tx.Exec(ctx,
			`UPDATE conversation_members SET visible = false, hidden_at_seq = $2
			 WHERE conversation_id = $1`, convID, seq)
		if err != nil {
			return err
		}

		evt := events.ConversationIgnored{
			Type:           events.TypeConversationIgnored,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			IgnoredBy:      callerID,
			Members:        []string{low, high},
			AtSeq:          seq,
		}
		if err := insertOutbox(ctx, tx, convID, evt); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// ── Block ───────────────────────────────────────────────────────────────────

// Block sets blocked=true on the caller's member row of the conversation with peerID.
func (s *Store) Block(ctx context.Context, orgID, callerID, peerID string) error {
	if callerID == peerID {
		return ErrForbidden
	}
	low, high := orderedPair(callerID, peerID)

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

		// Blocking creates the conversation row if there is none, so the peer
		// must be in this org for the same reason as in SendMessage.
		if err := requireSameOrgUser(ctx, tx, orgID, peerID); err != nil {
			return err
		}

		// Ensure conversation + caller member row exist so the block sticks.
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

		_, err = tx.Exec(ctx,
			`INSERT INTO conversation_members (conversation_id, org_id, user_id, blocked)
			 VALUES ($1, $2, $3, true)
			 ON CONFLICT (conversation_id, user_id) DO UPDATE SET blocked = true`,
			convID, orgID, callerID)
		if err != nil {
			return err
		}

		// Fan out to BOTH members so the peer's composer flips to "You have been
		// blocked" live and the blocker's other devices sync. Same outbox→Kafka→
		// gateway path as ConversationIgnored.
		evt := events.ConversationBlocked{
			Type:           events.TypeConversationBlocked,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			BlockedBy:      callerID,
			Members:        []string{low, high},
		}
		if err := insertOutbox(ctx, tx, convID, evt); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// Unblock clears blocked on the caller's member row of the conversation with
// peerID and emits conversation.unblocked. Clears ONLY the caller's side — if
// the peer also blocked, the conversation stays blocked until they unblock too.
func (s *Store) Unblock(ctx context.Context, orgID, callerID, peerID string) error {
	if callerID == peerID {
		return ErrForbidden
	}
	low, high := orderedPair(callerID, peerID)

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

		// Look up the conversation; if it never existed there's nothing to unblock.
		var convID string
		err = tx.QueryRow(ctx,
			`SELECT id FROM conversations WHERE org_id = $1 AND user_low = $2 AND user_high = $3`,
			orgID, low, high).Scan(&convID)
		if errors.Is(err, pgx.ErrNoRows) {
			// No conversation → no block to clear. Idempotent success.
			return tx.Commit(ctx)
		}
		if err != nil {
			return err
		}

		if _, err := tx.Exec(ctx,
			`UPDATE conversation_members SET blocked = false
			 WHERE conversation_id = $1 AND user_id = $2`,
			convID, callerID); err != nil {
			return err
		}

		evt := events.ConversationUnblocked{
			Type:           events.TypeConversationUnblocked,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			UnblockedBy:    callerID,
			Members:        []string{low, high},
		}
		if err := insertOutbox(ctx, tx, convID, evt); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// ── Reads ─────────────────────────────────────────────────────────────────────

// rawConv holds one conversation-list row's columns before the last-message
// preview is decrypted — see ListConversations.
type rawConv struct {
	d            ConversationDTO
	lastMsg      *string
	lastEnc      []byte
	lastAt       *time.Time
	cleared      bool
	lastSenderID *string
}

// ListConversations returns the caller's visible conversations, newest activity first.
//
// RLS: runs inside withOrg so app.org_id is set for both the SELECT and the
// DEK warm-up below (org_keys is RLS-protected too). Rows are buffered raw
// and decrypted AFTER the tx commits and its pooled connection is released —
// Phase 11 found this endpoint holding a connection through the per-row
// AES-GCM/JSON work on top of the query, well past what the query itself
// needed, against a pool deliberately capped at 10 (see store.go's comment
// on the platform-wide connection budget, not raised here). See
// PeekVersion/WarmVersions/DecryptCached in internal/crypto/crypto.go.
func (s *Store) ListConversations(ctx context.Context, orgID, callerID string) ([]ConversationDTO, error) {
	var raws []rawConv
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT
			    c.id,
			    CASE WHEN c.user_low = $2 THEN c.user_high ELSE c.user_low END AS peer_id,
			    COALESCE(up.username, '') AS peer_username,
			    COALESCE(up.display_name, '') AS peer_display_name,
			    lm.body,
			    lm.body_enc,
			    c.last_msg_at,
			    -- True when the caller has hidden every message up to the newest one
			    -- (Clear Chat, or hiding each message individually) but the
			    -- conversation genuinely has history — distinct from a conversation
			    -- that has never had a message at all, which keeps its usual
			    -- "Start chatting" placeholder client-side. last_msg_at is set once,
			    -- on the first message (messages.go), and clearing never resets it,
			    -- so "not null" is a free stand-in for "has ever had a message".
			    (lm.body IS NULL AND lm.body_enc IS NULL AND c.last_msg_at IS NOT NULL) AS cleared,
			    COALESCE((
			        SELECT count(*) FROM messages m2
			        WHERE m2.conversation_id = c.id
			          AND m2.sender_id <> $2
			          AND m2.seq > cm.last_read_seq
			          -- Same exclusion the lm preview below already applies:
			          -- ClearConversation/HideMessage only ever insert into
			          -- message_hides, never touch last_read_seq (there is
			          -- nothing left to mark read once every message is
			          -- hidden). Without this, clearing a chat left its badge
			          -- permanently stuck on a conversation that looks empty,
			          -- with no message left for the client to ever call
			          -- MarkRead against.
			          AND NOT EXISTS (
			              SELECT 1 FROM message_hides h
			              WHERE h.message_id = m2.id AND h.user_id = $2
			          )
			    ), 0) AS unread,
			    COALESCE(cm.blocked, false) AS blocked_by_me,
			    COALESCE(pm.blocked, false) AS blocked_by_peer,
			    lm.sender_id AS last_message_sender_id
			FROM conversations c
			JOIN conversation_members cm
			    ON cm.conversation_id = c.id AND cm.user_id = $2
			LEFT JOIN conversation_members pm
			    ON pm.conversation_id = c.id
			   AND pm.user_id = (CASE WHEN c.user_low = $2 THEN c.user_high ELSE c.user_low END)
			LEFT JOIN LATERAL (
			    SELECT body, body_enc, sender_id FROM messages m
			    WHERE m.conversation_id = c.id
			      -- An unsent message keeps its body_enc (deleting for everyone only
			      -- stamps this column), so it must be skipped here or its text
			      -- stays on show as the "last message" to both people.
			      AND m.deleted_for_all_at IS NULL
			      -- Skips messages THIS caller cleared/hid, so the preview shows the
			      -- newest message the caller can actually still see rather than one
			      -- they deliberately hid (see ClearConversation/HideMessage).
			      AND NOT EXISTS (
			          SELECT 1 FROM message_hides h
			          WHERE h.message_id = m.id AND h.user_id = $2
			      )
			    ORDER BY m.seq DESC LIMIT 1
			) lm ON true
			LEFT JOIN user_projection up
			    ON up.user_id = (CASE WHEN c.user_low = $2 THEN c.user_high ELSE c.user_low END)
			WHERE c.org_id = $1 AND cm.visible = true
			ORDER BY c.last_msg_at DESC NULLS LAST`,
			orgID, callerID)
		if err != nil {
			return err
		}

		// Buffer raw rows so the cursor is fully drained before the DEK warm-up
		// query below runs on the same tx.
		for rows.Next() {
			var rc rawConv
			if err := rows.Scan(&rc.d.ID, &rc.d.PeerID, &rc.d.PeerUsername, &rc.d.PeerDisplayName,
				&rc.lastMsg, &rc.lastEnc, &rc.lastAt, &rc.cleared, &rc.d.Unread,
				&rc.d.BlockedByMe, &rc.d.BlockedByPeer, &rc.lastSenderID); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, rc)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		versions := map[int]struct{}{}
		for _, rc := range raws {
			if v, ok := s.crypto.PeekVersion(rc.lastEnc); ok {
				versions[v] = struct{}{}
			}
		}
		return s.crypto.WarmVersions(ctx, tx, orgID, versions)
	})
	if err != nil {
		return nil, err
	}

	out := make([]ConversationDTO, 0, len(raws))
	for _, rc := range raws {
		d := rc.d
		d.Cleared = rc.cleared
		if rc.lastSenderID != nil {
			d.LastMessageSenderID = *rc.lastSenderID
		}
		// Decrypt the single last-message preview; legacy plaintext is fallback.
		if rc.lastEnc != nil {
			dec, derr := s.crypto.DecryptCached(orgID, rc.lastEnc)
			if derr != nil {
				return nil, derr
			}
			d.LastMessage = &dec
		} else {
			d.LastMessage = rc.lastMsg
		}
		if rc.lastAt != nil {
			iso := rc.lastAt.UTC().Format("2006-01-02T15:04:05.000Z")
			d.LastMessageAt = &iso
		}
		out = append(out, d)
	}
	return out, nil
}
