package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// Channel roles. `owner` is the creator (or whoever it was transferred to);
// `admin` is a moderator they appointed; everyone else is `member`.
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// ChannelMember is one row of the roster: who, and with what standing.
type ChannelMember struct {
	UserID   string `json:"userId"`
	Role     string `json:"role"`
	JoinedAt string `json:"joinedAt"`
	Blocked  bool   `json:"blocked"`
}

// channelRole returns the caller's role in a channel, or "" if not a member.
func channelRole(ctx context.Context, tx pgx.Tx, channelID, userID string) (string, error) {
	var role string
	err := tx.QueryRow(ctx,
		`SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return role, err
}

// isOrgAdmin reports whether the VERIFIED JWT claims carry org_admin.
//
// Read from the token rather than from a table because messaging-svc has no
// copy of the org's role assignments — auth-svc owns them, and mirroring them
// here would be a second source of truth that goes stale. The documented cost is
// that a demotion takes effect at the target's next token refresh — which is
// JWT_ACCESS_TTL_SECONDS, raised from 900 to 3600 to cut auth-svc's refresh
// write rate, so the window is now about an hour rather than fifteen minutes.
//
// Still acceptable HERE, where the worst case is one extra kick from a channel,
// and it is the same trade every other service in this stack makes. It is not
// acceptable everywhere: the endpoints where an hour of stale authority would
// matter re-read the role from the database instead (see auth-svc's
// require_live_admin on org deletion).
func isOrgAdmin(claimRoles []string) bool {
	for _, r := range claimRoles {
		if r == "org_admin" {
			return true
		}
	}
	return false
}

// channelManagerCheck answers whether the caller may moderate the channel —
// its owner, one of its admins, or an org_admin — rather than refusing when
// they may not.
//
// Split out of requireChannelManager so a bulk operation (delete, say) can
// decide ONCE, up front, which of two authorized-sets a whole batch falls
// under (moderator: everyone's messages; plain member: only their own)
// instead of asking "am I allowed to touch THIS one" per row.
//
// A channel that does not exist or belongs to another org still returns
// ErrForbidden directly (not (false, nil)) — that is not a question about the
// caller's standing, it is the same "this id is not something you get an
// answer about" refusal every other id-taking path in this package makes.
func channelManagerCheck(
	ctx context.Context, tx pgx.Tx, orgID, channelID, userID string, claimRoles []string,
) (bool, error) {
	var cOrg string
	err := tx.QueryRow(ctx, `SELECT org_id FROM channels WHERE id = $1`, channelID).Scan(&cOrg)
	if err := classifyChannelOrgLookup(err, cOrg, orgID); err != nil {
		return false, err
	}
	if isOrgAdmin(claimRoles) {
		return true, nil
	}
	role, err := channelRole(ctx, tx, channelID, userID)
	if err != nil {
		return false, err
	}
	return role == RoleOwner || role == RoleAdmin, nil
}

// requireChannelManager returns ErrForbidden unless the caller may moderate
// the channel: its owner, one of its admins, or an org_admin.
//
// An org_admin is NOT required to be a member — moderating a channel you are not
// in is the point of the capability. The channel must still belong to the
// caller's org, which channelManagerCheck's explicit org check enforces
// alongside RLS.
func requireChannelManager(
	ctx context.Context, tx pgx.Tx, orgID, channelID, userID string, claimRoles []string,
) error {
	ok, err := channelManagerCheck(ctx, tx, orgID, channelID, userID, claimRoles)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	return nil
}

// isBlocked reports whether a user is barred from a channel.
func isBlocked(ctx context.Context, tx pgx.Tx, channelID, userID string) (bool, error) {
	var blocked bool
	err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_blocks WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID).Scan(&blocked)
	return blocked, err
}

// ChannelRoster lists one page of the channel's members with their roles,
// plus one page of anyone blocked from it. Callers must be a member, or an
// org_admin.
//
// PAGED via limit/offset — clampChannelPage/clampOffset, the same convention
// ListOpenChannels uses (channels_membership.go) — applied INDEPENDENTLY to
// the members list and the blocked list: they are two different populations
// sharing one response for UI convenience, not one ordered sequence, so
// there is no single cursor that means the same thing for both. Before this,
// neither query had a LIMIT at all — inconsistent with every other listing in
// this package, and an org-wide channel or a heavily-moderated one could
// return an unbounded number of rows in one response. limit/offset are
// clamped again here, not only at the HTTP layer, because the ceiling has to
// hold for every caller and not just the one that came through a URL — same
// rule ListOpenChannels' doc comment gives.
func (s *Store) ChannelRoster(
	ctx context.Context, orgID, channelID, callerID string, claimRoles []string, limit, offset int,
) ([]ChannelMember, error) {
	limit = clampChannelPage(limit)
	offset = clampOffset(offset)
	var out []ChannelMember
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		// Seeing who is in a room requires being in it — except for org admins, who
		// can already see every channel in their workspace.
		if !isOrgAdmin(claimRoles) {
			if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
				return err
			}
		}

		rows, err := tx.Query(ctx,
			`SELECT user_id, role, joined_at FROM channel_members
			  WHERE channel_id = $1 ORDER BY
			    CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at, user_id
			  LIMIT $2 OFFSET $3`,
			channelID, limit, offset)
		if err != nil {
			return err
		}
		result := []ChannelMember{}
		for rows.Next() {
			var m ChannelMember
			var joined time.Time
			if err := rows.Scan(&m.UserID, &m.Role, &joined); err != nil {
				rows.Close()
				return err
			}
			m.JoinedAt = joined.UTC().Format("2006-01-02T15:04:05.000Z")
			result = append(result, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// Blocked users are listed too — they are not members, but an admin looking
		// at the roster needs to see who has been barred in order to unblock them.
		// Ordered explicitly (created_at, user_id) so paging is stable rather than
		// left to whatever order the planner happens to scan rows in.
		brows, err := tx.Query(ctx,
			`SELECT user_id FROM channel_blocks WHERE channel_id = $1
			  ORDER BY created_at, user_id
			  LIMIT $2 OFFSET $3`,
			channelID, limit, offset)
		if err != nil {
			return err
		}
		for brows.Next() {
			var uid string
			if err := brows.Scan(&uid); err != nil {
				brows.Close()
				return err
			}
			result = append(result, ChannelMember{UserID: uid, Role: RoleMember, Blocked: true})
		}
		brows.Close()
		if err := brows.Err(); err != nil {
			return err
		}

		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = result
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// emitChannelEvent writes one membership/moderation event to the outbox,
// addressed to the surviving members PLUS the affected user — who is usually no
// longer a member and would otherwise never learn what happened to them.
func emitChannelEvent(
	ctx context.Context, tx pgx.Tx, evtType, orgID, channelID, userID, actorID string,
) error {
	members, err := channelMemberIDs(ctx, tx, channelID)
	if err != nil {
		return err
	}
	return insertOutbox(ctx, tx, channelID, events.ChannelMembershipChanged{
		Type:       evtType,
		EventID:    uuid.Must(uuid.NewV7()).String(),
		OrgID:      orgID,
		OccurredAt: nowISO(),
		ChannelID:  channelID,
		UserID:     userID,
		ActorID:    actorID,
		Members:    members,
	})
}
