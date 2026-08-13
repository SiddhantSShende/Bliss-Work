package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// CreateChannel creates a group channel owned by creator and seeds its members.
// The creator is always included as a member.
//
// `isLocked` decides the visibility model: false means anyone in the org can
// later self-join via /channels/{id}/join; true means new members can only be
// added by an existing member via /channels/{id}/members (the legacy invite
// path).
func (s *Store) CreateChannel(ctx context.Context, orgID, creatorID, name string, isLocked bool, memberIDs []string) (*ChannelDTO, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	chanID := uuid.Must(uuid.NewV7()).String()
	_, err = tx.Exec(ctx,
		`INSERT INTO channels (id, org_id, name, is_locked, created_by) VALUES ($1, $2, $3, $4, $5)`,
		chanID, orgID, name, isLocked, creatorID)
	if err != nil {
		return nil, err
	}

	members := dedupeMembers(creatorID, memberIDs)
	for _, uid := range members {
		if err := s.insertChannelMember(ctx, tx, chanID, orgID, uid); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ChannelDTO{
		ID:          chanID,
		Name:        name,
		MemberCount: len(members),
		IsLocked:    isLocked,
		IAmMember:   true,
	}, nil
}

// AddChannelMembers adds members to a channel; caller must already be a
// member. Emits ChannelMemberJoined for every member that was actually new
// (re-adding an existing member is a no-op and emits nothing).
func (s *Store) AddChannelMembers(ctx context.Context, orgID, channelID, callerID string, memberIDs []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
		return err
	}
	for _, uid := range dedupeMembers("", memberIDs) {
		// Re-adding a blocked user would silently undo a moderation decision.
		// 403 rather than skipping, so the caller learns why.
		if blocked, err := isBlocked(ctx, tx, channelID, uid); err != nil {
			return err
		} else if blocked {
			return ErrForbidden
		}
		var alreadyMember bool
		err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
			channelID, uid).Scan(&alreadyMember)
		if err != nil {
			return err
		}
		if err := s.insertChannelMember(ctx, tx, channelID, orgID, uid); err != nil {
			return err
		}
		if !alreadyMember {
			if err := emitChannelMemberJoined(ctx, tx, orgID, channelID, uid); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// SendChannelMessage appends a message to a channel. Caller must be a member.
// Idempotent on (channel, sender, clientMsgId).
func (s *Store) SendChannelMessage(ctx context.Context, orgID, channelID, senderID, body, clientMsgID string) (*ChannelSendResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	if err := requireChannelMember(ctx, tx, orgID, channelID, senderID); err != nil {
		return nil, err
	}
	// A block WITHOUT a kick is a mute: the member keeps their row and keeps
	// reading, but cannot post. Checked on the send path for the same reason the
	// DM block is (messages.go) — the authoritative gate belongs where the write
	// happens, not only where the UI hides a button.
	if blocked, err := isBlocked(ctx, tx, channelID, senderID); err != nil {
		return nil, err
	} else if blocked {
		return nil, ErrForbidden
	}

	// Idempotency: return the existing message if this client_msg_id was seen.
	var existingID string
	var existingSeq int64
	err = tx.QueryRow(ctx,
		`SELECT id, seq FROM channel_messages
		 WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
		channelID, senderID, clientMsgID).Scan(&existingID, &existingSeq)
	if err == nil {
		if cerr := tx.Commit(ctx); cerr != nil {
			return nil, cerr
		}
		return &ChannelSendResult{MessageID: existingID, Seq: existingSeq}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	// Allocate the next seq atomically and bump last activity.
	var seq int64
	err = tx.QueryRow(ctx,
		`UPDATE channels SET seq_counter = seq_counter + 1, last_msg_at = now()
		 WHERE id = $1 RETURNING seq_counter`, channelID).Scan(&seq)
	if err != nil {
		return nil, err
	}

	// Encrypt the body under the org DEK (created lazily in THIS tx); the
	// plaintext body column is left NULL.
	bodyEnc, err := s.crypto.Encrypt(ctx, tx, orgID, body)
	if err != nil {
		return nil, err
	}
	msgID := uuid.Must(uuid.NewV7()).String()
	_, err = tx.Exec(ctx,
		`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, body_enc, client_msg_id)
		 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
		msgID, orgID, channelID, seq, senderID, bodyEnc, clientMsgID)
	if err != nil {
		return nil, err
	}

	members, err := channelMemberIDs(ctx, tx, channelID)
	if err != nil {
		return nil, err
	}
	// Both names travel on the event so a message arriving over the socket
	// renders the same as one that came back from a refetch. Sending only the
	// username made a live message flip from "Jane Okafor" to "j.okafor" until
	// the next fetch.
	senderName, senderDisplay, err := userNames(ctx, tx, senderID)
	if err != nil {
		return nil, err
	}

	evt := events.ChannelMessageCreated{
		Type:              events.TypeChannelMessageCreated,
		EventID:           uuid.Must(uuid.NewV7()).String(),
		OrgID:             orgID,
		OccurredAt:        nowISO(),
		ChannelID:         channelID,
		MessageID:         msgID,
		Seq:               seq,
		SenderID:          senderID,
		SenderUsername:    senderName,
		SenderDisplayName: senderDisplay,
		Body:              body,
		Members:           members,
	}
	if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ChannelSendResult{MessageID: msgID, Seq: seq}, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

// insertChannelMember adds a member row, ignoring duplicates.
func (s *Store) insertChannelMember(ctx context.Context, tx pgx.Tx, channelID, orgID, userID string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1, $2, $3)
		 ON CONFLICT (channel_id, user_id) DO NOTHING`,
		channelID, orgID, userID)
	return err
}

// requireChannelMember returns ErrForbidden unless the user is a member of the
// channel within the given org.
func requireChannelMember(ctx context.Context, tx pgx.Tx, orgID, channelID, userID string) error {
	var cOrg string
	err := tx.QueryRow(ctx, `SELECT org_id FROM channels WHERE id = $1`, channelID).Scan(&cOrg)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	var exists bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

// channelMemberIDs returns all member user ids of a channel.
func channelMemberIDs(ctx context.Context, tx pgx.Tx, channelID string) ([]string, error) {
	rows, err := tx.Query(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1 ORDER BY joined_at`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// userNames resolves both projected names for a user; either may be empty if
// unknown. Callers that render a person should prefer displayName and fall back
// to username, which is only the EMAIL LOCAL-PART (see auth-svc signup).
func userNames(ctx context.Context, tx pgx.Tx, userID string) (uname, display string, err error) {
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(username, ''), COALESCE(display_name, '')
		 FROM user_projection WHERE user_id = $1`, userID).Scan(&uname, &display)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return uname, display, err
}

// username resolves a user_projection username, empty if unknown.
func username(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var name string
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(username, '') FROM user_projection WHERE user_id = $1`, userID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// dedupeMembers returns the de-duplicated union of must (if non-empty) and ids.
func dedupeMembers(must string, ids []string) []string {
	seen := make(map[string]struct{}, len(ids)+1)
	out := make([]string, 0, len(ids)+1)
	add := func(v string) {
		if v == "" {
			return
		}
		if _, ok := seen[v]; ok {
			return
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	add(must)
	for _, v := range ids {
		add(v)
	}
	return out
}
