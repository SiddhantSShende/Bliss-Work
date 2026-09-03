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

// ListOpenChannels returns one page of the OPEN channels in the org the caller
// is NOT currently a member of. Locked channels are excluded — they only appear
// via invite. Results are ordered by recent activity so the most lively channels
// surface first.
//
// PAGED, and this is the endpoint that most needed it. Its population is every
// open channel in the organisation rather than just the caller's own, so it grew
// with the org and was bounded by nothing: an org with fifty thousand channels
// returned fifty thousand rows, each with a LATERAL lookup of its last message,
// each then decrypted individually in Go. The sibling ListChannels is left
// unpaged deliberately — it returns the caller's OWN memberships, which the
// sidebar needs in full and which a person bounds by joining a human number of
// channels.
//
// limit is clamped to maxChannelPage and offset floored at zero, in the store
// rather than only at the HTTP layer, because the ceiling has to hold for every
// caller and not just the one that came through a URL.
func (s *Store) ListOpenChannels(
	ctx context.Context, orgID, callerID string, limit, offset int,
) ([]ChannelDTO, error) {
	limit = clampChannelPage(limit)
	offset = clampOffset(offset)
	out := []ChannelDTO{}
	// Routed to the replica: this is the org-wide "browse channels I could
	// join" directory, not the caller's own memberships, so it carries no
	// read-after-write tie to anything the caller just did. See "Read
	// replicas" in store.go for the rule this follows.
	//
	// RLS: channel listing + per-row last-message decrypt run under app.org_id.
	err := s.withReplicaOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Member counts are aggregated ONCE for the whole result, not once per
		// row — the same fix as ListChannels, and this is the more exposed of
		// the two: Browse considers every open channel in the org rather than
		// just the caller's, so the correlated `(SELECT count(*) ...)` it used
		// to carry ran a SubPlan for each of them on every page load.
		//
		// `candidates` names the eligible set once, so the aggregate and the
		// outer join are both restricted to it. Computing counts before
		// filtering would count members of every channel in the org to answer a
		// question about the few the caller can actually join.
		rows, err := tx.Query(ctx, `
			WITH candidates AS (
			    SELECT c.id
			    FROM channels c
			    WHERE c.org_id = $1
			      AND c.is_locked = false
			      AND NOT EXISTS (
			          SELECT 1 FROM channel_members cm
			          WHERE cm.channel_id = c.id AND cm.user_id = $2
			      )
			      -- Hide channels the caller is blocked from, so Browse never
			      -- shows a Join button that is guaranteed to 403.
			      AND NOT EXISTS (
			          SELECT 1 FROM channel_blocks cb
			          WHERE cb.channel_id = c.id AND cb.user_id = $2
			      )
			),
			counts AS (
			    SELECT cm.channel_id, count(*) AS n
			    FROM channel_members cm
			    JOIN candidates ON candidates.id = cm.channel_id
			    GROUP BY cm.channel_id
			)
			SELECT
			    c.id,
			    c.name,
			    COALESCE(counts.n, 0) AS member_count,
			    lm.body,
			    lm.body_enc,
			    c.last_msg_at,
			    COALESCE(NULLIF(up.display_name, ''), up.username, '') AS last_message_sender,
			    -- Same "cleared vs. never messaged" distinction as ListChannels — kept
			    -- here too so scanRawChannelRows' projection stays identical for both.
			    (lm.body IS NULL AND lm.body_enc IS NULL AND c.last_msg_at IS NOT NULL) AS cleared,
			    c.is_locked,
			    c.created_by,
			    NULL::text AS my_role,  -- not a member by definition of this view
			    0::bigint AS unread,    -- unread has no meaning for a channel you haven't joined
			    lm.sender_id AS last_message_sender_id
			FROM channels c
			JOIN candidates ON candidates.id = c.id
			LEFT JOIN counts ON counts.channel_id = c.id
			LEFT JOIN LATERAL (
			    SELECT body, body_enc, sender_id FROM channel_messages m
			    WHERE m.channel_id = c.id
			      AND NOT EXISTS (
			          SELECT 1 FROM message_hides h
			          WHERE h.message_id = m.id AND h.user_id = $2
			      )
			    ORDER BY m.seq DESC LIMIT 1
			) lm ON true
			LEFT JOIN user_projection up ON up.user_id = lm.sender_id
			-- c.id breaks ties so the ordering is TOTAL. Without it two channels
			-- with the same last_msg_at and created_at could come back in either
			-- order between pages, which is how a paged reader silently skips a
			-- row and sees another twice.
			ORDER BY c.last_msg_at DESC NULLS LAST, c.created_at DESC, c.id DESC
			LIMIT $3 OFFSET $4`,
			orgID, callerID, limit, offset)
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

		var cOrg, cName string
		var locked bool
		err = tx.QueryRow(ctx,
			`SELECT org_id, is_locked, name FROM channels WHERE id = $1`, channelID).Scan(&cOrg, &locked, &cName)
		if err := classifyChannelOrgLookup(err, cOrg, orgID); err != nil {
			return err
		}
		if locked {
			return ErrForbidden
		}
		// THE case the block table exists for: without this, kicking a disruptive
		// member from an OPEN channel accomplishes nothing — they re-join.
		if blocked, err := isBlocked(ctx, tx, channelID, callerID); err != nil {
			return err
		} else if blocked {
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
		// Self-join is always an ordinary member — joining an open channel is not
		// a claim on it.
		if err := s.insertChannelMember(ctx, tx, channelID, orgID, callerID, RoleMember); err != nil {
			return err
		}
		if !alreadyMember {
			// actor == caller: this is a self-join, which notification-svc uses to
			// stay quiet. Nobody needs telling about a button they just pressed.
			if err := emitChannelMemberJoined(ctx, tx, orgID, channelID, cName, callerID, callerID); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	})
}

// emitChannelMemberJoined writes a ChannelMemberJoined outbox row inside the
// caller's transaction. The username is resolved best-effort — an empty value
// is fine for downstream consumers (they all key off userId anyway).
//
// `actorID` is who performed the add; pass userID itself for a self-join. See
// the event's doc comment for why the distinction is load-bearing.
func emitChannelMemberJoined(ctx context.Context, tx pgx.Tx, orgID, channelID, channelName, userID, actorID string) error {
	name, _ := username(ctx, tx, userID)
	evt := events.ChannelMemberJoined{
		Type:        events.TypeChannelMemberJoined,
		EventID:     uuid.Must(uuid.NewV7()).String(),
		OrgID:       orgID,
		OccurredAt:  nowISO(),
		ChannelID:   channelID,
		ChannelName: channelName,
		UserID:      userID,
		Username:    name,
		ActorID:     actorID,
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
	var out *ChannelMembershipSnapshot
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: trusted internal service-to-service path (task-svc fan-out) with NO
		// caller org in scope — the org is RESOLVED FROM the channel row. BYPASS.
		if err := setBypassGUC(ctx, tx); err != nil {
			return err
		}

		var orgID string
		var locked bool
		err = tx.QueryRow(ctx,
			`SELECT org_id, is_locked FROM channels WHERE id = $1`, channelID).Scan(&orgID, &locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		ids, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = &ChannelMembershipSnapshot{OrgID: orgID, IsLocked: locked, MemberIDs: ids}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ChannelMemberIDs returns every member user id of the channel. The caller
// must themselves be a member, since this exposes who else is in the room.
// (For the public "browse open channels" view we surface only the *count*,
// not the list of members.)
//
// Deliberately uses channelMemberIDsAll rather than the capped
// channelMemberIDs: this is the one call site that genuinely needs the
// COMPLETE roster (see that function's comment) rather than a bounded
// fan-out sample.
func (s *Store) ChannelMemberIDs(ctx context.Context, orgID, channelID, callerID string) ([]string, error) {
	var out []string
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

		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		ids, err := channelMemberIDsAll(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = ids
		return nil
	})
	if err != nil {
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

		var cOrg string
		err = tx.QueryRow(ctx,
			`SELECT org_id FROM channels WHERE id = $1`, channelID).Scan(&cOrg)
		if err := classifyChannelOrgLookup(err, cOrg, orgID); err != nil {
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
	})
}
