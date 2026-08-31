package store

import (
	"context"
	"errors"

	"github.com/task-board/messaging-svc/internal/events"
)

// ErrLastOwner is returned when an action would leave a channel with no owner.
var ErrLastOwner = errors.New("channel would be left without an owner")

// KickChannelMember removes someone from a channel. Manager-only.
//
// Guards, in order of how likely they are to be hit by accident:
//   - you cannot kick yourself (that is Leave, and it writes a different reason)
//   - nobody can kick the owner — including an org_admin, who should transfer
//     ownership rather than decapitate the channel
//   - an admin cannot kick a fellow admin; only the owner or an org_admin can,
//     so two moderators cannot get into a removal war
func (s *Store) KickChannelMember(
	ctx context.Context, orgID, channelID, callerID, targetID string, claimRoles []string,
) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
			return err
		}
		if callerID == targetID {
			return ErrForbidden
		}

		targetRole, err := channelRole(ctx, tx, channelID, targetID)
		if err != nil {
			return err
		}
		if targetRole == "" {
			return nil // not a member — idempotent, nothing to remove
		}
		if targetRole == RoleOwner {
			return ErrLastOwner
		}
		if targetRole == RoleAdmin {
			callerRole, err := channelRole(ctx, tx, channelID, callerID)
			if err != nil {
				return err
			}
			if callerRole != RoleOwner && !isOrgAdmin(claimRoles) {
				return ErrForbidden
			}
		}

		tag, err := tx.Exec(ctx,
			`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
			channelID, targetID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return tx.Commit(ctx)
		}
		// 'kicked' has been a documented value of this column since 0005 with no
		// code that ever wrote it. This is that code.
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_member_history (channel_id, org_id, user_id, reason)
			 VALUES ($1, $2, $3, 'kicked')`,
			channelID, orgID, targetID); err != nil {
			return err
		}
		if err := emitChannelEvent(
			ctx, tx, events.TypeChannelMemberRemoved, orgID, channelID, targetID, callerID,
		); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// SetChannelMemberRole promotes or demotes a member. Owner or org_admin only —
// an admin cannot mint more admins, which keeps the moderator set something the
// owner actually chose.
//
// Promoting to `owner` TRANSFERS ownership: the previous owner becomes an admin.
// Two owners would make "nobody can kick the owner" ambiguous.
func (s *Store) SetChannelMemberRole(
	ctx context.Context, orgID, channelID, callerID, targetID, role string, claimRoles []string,
) error {
	if role != RoleOwner && role != RoleAdmin && role != RoleMember {
		return ErrForbidden
	}
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
			return err
		}

		callerRole, err := channelRole(ctx, tx, channelID, callerID)
		if err != nil {
			return err
		}
		if callerRole != RoleOwner && !isOrgAdmin(claimRoles) {
			return ErrForbidden
		}

		targetRole, err := channelRole(ctx, tx, channelID, targetID)
		if err != nil {
			return err
		}
		if targetRole == "" {
			return ErrForbidden // not a member; add them first
		}
		// Demoting the only owner would leave the channel unmoderatable by anyone
		// except an org admin.
		if targetRole == RoleOwner && role != RoleOwner {
			return ErrLastOwner
		}

		if role == RoleOwner {
			if _, err := tx.Exec(ctx,
				`UPDATE channel_members SET role = 'admin'
				  WHERE channel_id = $1 AND role = 'owner'`, channelID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE channel_members SET role = $3 WHERE channel_id = $1 AND user_id = $2`,
			channelID, targetID, role); err != nil {
			return err
		}
		if err := emitChannelEvent(
			ctx, tx, events.TypeChannelRoleChanged, orgID, channelID, targetID, callerID,
		); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// BlockFromChannel bars someone from a channel and removes them if present.
//
// The block outlives membership by design — see 0013_channel_blocks.sql. Without
// it, kicking someone from an OPEN channel accomplishes nothing: they simply
// re-join.
func (s *Store) BlockFromChannel(
	ctx context.Context, orgID, channelID, callerID, targetID, reason string, claimRoles []string,
) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
			return err
		}
		if callerID == targetID {
			return ErrForbidden
		}
		targetRole, err := channelRole(ctx, tx, channelID, targetID)
		if err != nil {
			return err
		}
		if targetRole == RoleOwner {
			return ErrLastOwner
		}
		// Same rule KickChannelMember enforces, and for the same reason: this is
		// a STRICTLY more drastic removal (it also bars rejoining an open
		// channel, which a plain kick does not), so it must not be reachable by
		// one admin against another when the milder kick explicitly is not.
		// Without this, block was the side door around "two moderators cannot
		// get into a removal war."
		if targetRole == RoleAdmin {
			callerRole, err := channelRole(ctx, tx, channelID, callerID)
			if err != nil {
				return err
			}
			if callerRole != RoleOwner && !isOrgAdmin(claimRoles) {
				return ErrForbidden
			}
		}

		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_blocks (channel_id, org_id, user_id, blocked_by, reason)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (channel_id, user_id) DO UPDATE SET blocked_by = EXCLUDED.blocked_by, reason = EXCLUDED.reason`,
			channelID, orgID, targetID, callerID, reason); err != nil {
			return err
		}
		if targetRole != "" {
			if _, err := tx.Exec(ctx,
				`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
				channelID, targetID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_member_history (channel_id, org_id, user_id, reason)
				 VALUES ($1, $2, $3, 'kicked')`,
				channelID, orgID, targetID); err != nil {
				return err
			}
		}
		if err := emitChannelEvent(
			ctx, tx, events.TypeChannelBlocked, orgID, channelID, targetID, callerID,
		); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// UnblockFromChannel lifts a block. It does NOT re-add the person: they can
// re-join an open channel themselves, and for a locked one a manager adds them
// back deliberately.
func (s *Store) UnblockFromChannel(
	ctx context.Context, orgID, channelID, callerID, targetID string, claimRoles []string,
) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx,
			`DELETE FROM channel_blocks WHERE channel_id = $1 AND user_id = $2`,
			channelID, targetID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return tx.Commit(ctx) // idempotent
		}
		if err := emitChannelEvent(
			ctx, tx, events.TypeChannelUnblocked, orgID, channelID, targetID, callerID,
		); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}
