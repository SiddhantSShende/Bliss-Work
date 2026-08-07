// channels_membership.go: open/locked semantics + self-join + leave.
//
// Three operations the canonical CreateChannel/AddChannelMembers pair didn't
// cover:
//
//	ListOpenChannels  — the directory of channels in the caller's org the
//	                    caller could join right now (open AND not yet a
//	                    member). The /channels endpoint (ListChannels)
//	                    already returns the caller's own channels; this is
//	                    the "browse" counterpart.
//
//	JoinChannel       — self-add for an open channel. Locked channels reject
//	                    with ErrForbidden; the caller has to be added by an
//	                    existing member via AddChannelMembers instead.
//
//	LeaveChannel      — soft-leave: drop the membership row and audit it in
//	                    channel_member_history so a future "you can re-join
//	                    open channels" UI flow has the timestamp to work
//	                    with.
package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// ListOpenChannels returns every OPEN channel in the org the caller is NOT
// currently a member of. Locked channels are excluded — they only appear via
// invite. Results are ordered by recent activity so the most lively channels
// surface first.
func (s *Store) ListOpenChannels(ctx context.Context, orgID, callerID string) ([]ChannelDTO, error) {
	out := []ChannelDTO{}
	// RLS: channel listing + per-row last-message decrypt run under app.org_id.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT
			    c.id,
			    c.name,
			    (SELECT count(*) FROM channel_members cm2 WHERE cm2.channel_id = c.id) AS member_count,
			    lm.body,
			    lm.body_enc,
			    c.last_msg_at,
			    c.is_locked
			FROM channels c
			LEFT JOIN LATERAL (
			    SELECT body, body_enc FROM channel_messages m
			    WHERE m.channel_id = c.id
			    ORDER BY m.seq DESC LIMIT 1
			) lm ON true
			WHERE c.org_id = $1
			  AND c.is_locked = false
			  AND NOT EXISTS (
			      SELECT 1 FROM channel_members cm
			      WHERE cm.channel_id = c.id AND cm.user_id = $2
			  )
			ORDER BY c.last_msg_at DESC NULLS LAST, c.created_at DESC`,
			orgID, callerID)
		if err != nil {
			return err
		}
		raws, err := scanRawChannelRows(rows)
		if err != nil {
			return err
		}
		for _, rc := range raws {
			d, derr := s.decryptChannelRow(ctx, tx, orgID, rc, false)
			if derr != nil {
				return derr
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

// JoinChannel adds the caller to an OPEN channel in their org. Idempotent.
// Locked channels return ErrForbidden — those require AddChannelMembers from
// an existing member.
//
// Emits ChannelMemberJoined on the messaging topic so task-svc can fan out
// any active channel-allocated tasks to the new member. The outbox row is
// written in the same transaction as the membership row so retries can't
// either double-emit or skip the fan-out.
func (s *Store) JoinChannel(ctx context.Context, orgID, channelID, callerID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	var cOrg string
	var locked bool
	err = tx.QueryRow(ctx,
		`SELECT org_id, is_locked FROM channels WHERE id = $1`, channelID).Scan(&cOrg, &locked)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if locked {
		return ErrForbidden
	}

	// Detect "actually new" so we only emit on a real join (idempotent retries
	// don't re-fan-out tasks).
	var alreadyMember bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, callerID).Scan(&alreadyMember)
	if err != nil {
		return err
	}
	if err := s.insertChannelMember(ctx, tx, channelID, orgID, callerID); err != nil {
		return err
	}
	if !alreadyMember {
		if err := emitChannelMemberJoined(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// emitChannelMemberJoined writes a ChannelMemberJoined outbox row inside the
// caller's transaction. The username is resolved best-effort — an empty value
// is fine for downstream consumers (they all key off userId anyway).
func emitChannelMemberJoined(ctx context.Context, tx pgx.Tx, orgID, channelID, userID string) error {
	name, _ := username(ctx, tx, userID)
	evt := events.ChannelMemberJoined{
		Type:       events.TypeChannelMemberJoined,
		EventID:    uuid.Must(uuid.NewV7()).String(),
		OrgID:      orgID,
		OccurredAt: nowISO(),
		ChannelID:  channelID,
		UserID:     userID,
		Username:   name,
	}
	return insertOutbox(ctx, tx, channelID, evt)
}

// InternalChannelMembership is the service-to-service variant of
// ChannelMemberIDs — no caller check, returns the org + lock flag + every
// member id so task-svc can fan out a channel-allocated task without
// holding the original caller's JWT.
type ChannelMembershipSnapshot struct {
	OrgID     string
	IsLocked  bool
	MemberIDs []string
}

func (s *Store) InternalChannelMembership(ctx context.Context, channelID string) (*ChannelMembershipSnapshot, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: trusted internal service-to-service path (task-svc fan-out) with NO
	// caller org in scope — the org is RESOLVED FROM the channel row. BYPASS.
	if err := setBypassGUC(ctx, tx); err != nil {
		return nil, err
	}

	var orgID string
	var locked bool
	err = tx.QueryRow(ctx,
		`SELECT org_id, is_locked FROM channels WHERE id = $1`, channelID).Scan(&orgID, &locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	ids, err := channelMemberIDs(ctx, tx, channelID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ChannelMembershipSnapshot{OrgID: orgID, IsLocked: locked, MemberIDs: ids}, nil
}

// ChannelMemberIDs returns every member user id of the channel. The caller
// must themselves be a member, since this exposes who else is in the room.
// (For the public "browse open channels" view we surface only the *count*,
// not the list of members.)
func (s *Store) ChannelMemberIDs(ctx context.Context, orgID, channelID, callerID string) ([]string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
		return nil, err
	}
	out, err := channelMemberIDs(ctx, tx, channelID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// LeaveChannel removes the caller from a channel they're currently a member of
// and writes an audit row to channel_member_history. Idempotent — leaving a
// channel the caller already left is a no-op.
//
// Special case: the creator of a channel is just another member; leaving is
// allowed but isn't a "delete channel" action. If every member leaves an
// open channel it stays in the org and a future joiner re-populates it.
func (s *Store) LeaveChannel(ctx context.Context, orgID, channelID, callerID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return err
	}

	var cOrg string
	err = tx.QueryRow(ctx,
		`SELECT org_id FROM channels WHERE id = $1`, channelID).Scan(&cOrg)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}

	tag, err := tx.Exec(ctx,
		`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, callerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Already not a member — nothing to do, but don't pretend we wrote
		// the audit row either.
		return tx.Commit(ctx)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO channel_member_history (channel_id, org_id, user_id, reason)
		 VALUES ($1, $2, $3, 'left')`,
		channelID, orgID, callerID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
