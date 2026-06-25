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
func (s *Store) upsertMember(ctx context.Context, tx pgx.Tx, convID, orgID, userID string, visible bool) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO conversation_members (conversation_id, org_id, user_id, visible)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (conversation_id, user_id)
		 DO UPDATE SET visible = $4, hidden_at_seq = NULL`,
		convID, orgID, userID, visible)
	return err
}

// ── Ignore ────────────────────────────────────────────────────────────────────

// Ignore hides the conversation for BOTH members and emits conversation.ignored.
func (s *Store) Ignore(ctx context.Context, orgID, callerID, convID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	var low, high, cOrg string
	var seq int64
	err = tx.QueryRow(ctx,
		`SELECT org_id, user_low, user_high, seq_counter FROM conversations WHERE id = $1`, convID).
		Scan(&cOrg, &low, &high, &seq)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if callerID != low && callerID != high {
		return ErrForbidden
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
	if err := insertOutbox(ctx, tx, events.TopicMessaging, convID, evt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ── Block ───────────────────────────────────────────────────────────────────

// Block sets blocked=true on the caller's member row of the conversation with peerID.
func (s *Store) Block(ctx context.Context, orgID, callerID, peerID string) error {
	if callerID == peerID {
		return ErrForbidden
	}
	low, high := orderedPair(callerID, peerID)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
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
	return tx.Commit(ctx)
}

// ── Reads ─────────────────────────────────────────────────────────────────────

// ListConversations returns the caller's visible conversations, newest activity first.
//
// RLS: runs inside withOrg so app.org_id is set for both the SELECT and the
// per-row Decrypt (org_keys is RLS-protected too). Rows are buffered raw and
// decrypted AFTER the cursor is closed — issuing the Decrypt query on the tx
// while rows.Next() is still iterating would error with "conn busy".
func (s *Store) ListConversations(ctx context.Context, orgID, callerID string) ([]ConversationDTO, error) {
	out := []ConversationDTO{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT
			    c.id,
			    CASE WHEN c.user_low = $2 THEN c.user_high ELSE c.user_low END AS peer_id,
			    COALESCE(up.username, '') AS peer_username,
			    lm.body,
			    lm.body_enc,
			    c.last_msg_at,
			    COALESCE((
			        SELECT count(*) FROM messages m2
			        WHERE m2.conversation_id = c.id
			          AND m2.sender_id <> $2
			          AND m2.seq > cm.last_read_seq
			    ), 0) AS unread
			FROM conversations c
			JOIN conversation_members cm
			    ON cm.conversation_id = c.id AND cm.user_id = $2
			LEFT JOIN LATERAL (
			    SELECT body, body_enc FROM messages m
			    WHERE m.conversation_id = c.id
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

		// Buffer raw rows so the cursor is fully drained before we run any
		// Decrypt query on the same tx.
		type rawConv struct {
			d       ConversationDTO
			lastMsg *string
			lastEnc []byte
			lastAt  *time.Time
		}
		var raws []rawConv
		for rows.Next() {
			var rc rawConv
			if err := rows.Scan(&rc.d.ID, &rc.d.PeerID, &rc.d.PeerUsername,
				&rc.lastMsg, &rc.lastEnc, &rc.lastAt, &rc.d.Unread); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, rc)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, rc := range raws {
			d := rc.d
			// Decrypt the single last-message preview; legacy plaintext is fallback.
			if rc.lastEnc != nil {
				dec, derr := s.crypto.Decrypt(ctx, tx, orgID, rc.lastEnc)
				if derr != nil {
					return derr
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
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
