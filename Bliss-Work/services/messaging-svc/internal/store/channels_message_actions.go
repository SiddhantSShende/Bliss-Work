package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// Hiding, deleting, pinning and reacting to CHANNEL messages.
//
// The DM twins of these live in message_actions.go and the semantics are
// deliberately identical where they can be — a user who has learned what
// "Delete for me" does in a chat must not find it means something else in a
// channel. What genuinely differs is WHO may act, and that difference is the
// reason this file exists rather than a `if channel { ... }` branch in the DM
// path:
//
//   - Delete for everyone in a DM is AUTHOR-ONLY. In a channel it is the author
//     OR someone who moderates the channel (owner, channel admin, org_admin),
//     because a channel is a shared space and removing someone else's message
//     from it is what moderation means.
//   - Pinning has no DM equivalent at all. It is MODERATOR-ONLY: "pin for
//     everyone" changes what every member sees at the top of the channel, which
//     is not a thing any member should be able to do to the rest.
//
// `message_hides` and `message_reactions` are shared with the DM path. Neither
// carries a foreign key, both are keyed on a bare message_id, and a channel
// message id comes from the same uuid v7 space — so `reactionsFor` and the hide
// filter work for both kinds of message unchanged. See 0022.

// channelForMessage resolves the channel a message belongs to AND checks the
// caller is a member of it, in one query.
//
// Fused on purpose. Resolving first and authorizing second would answer "does
// this message id exist?" to a non-member through the difference between a 404
// and a 403 — the same probe `HideMessage` closes for conversations. Not a
// member (or no such message) is one indistinguishable ErrForbidden.
func channelForMessage(
	ctx context.Context, tx pgx.Tx, orgID, messageID, callerID string,
) (string, error) {
	var channelID string
	err := tx.QueryRow(ctx, `
		SELECT m.channel_id
		FROM channel_messages m
		JOIN channel_members cm
		  ON cm.channel_id = m.channel_id AND cm.user_id = $2
		WHERE m.id = $1 AND m.org_id = $3`,
		messageID, callerID, orgID).Scan(&channelID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrForbidden
	}
	return channelID, err
}

// HideChannelMessage removes one message from ONE member's view of a channel.
// Any member may hide any message they can see. Idempotent.
func (s *Store) HideChannelMessage(ctx context.Context, orgID, callerID, messageID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := channelForMessage(ctx, tx, orgID, messageID, callerID); err != nil {
			return err
		}
		// No event: a hide is invisible to everyone else by definition, so
		// broadcasting it would leak one member's reading habits to the channel.
		_, err := tx.Exec(ctx, `
			INSERT INTO message_hides (message_id, user_id, org_id)
			VALUES ($1, $2, $3)
			ON CONFLICT (message_id, user_id) DO NOTHING`,
			messageID, callerID, orgID)
		return err
	})
}

// ClearChannel hides the complete channel history for one reader.
func (s *Store) ClearChannel(ctx context.Context, orgID, channelID, callerID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO message_hides (message_id, user_id, org_id)
			SELECT id, $2, $3 FROM channel_messages WHERE channel_id = $1
			ON CONFLICT (message_id, user_id) DO NOTHING`, channelID, callerID, orgID)
		return err
	})
}

// DeleteChannelMessageForAll tombstones a channel message for everyone.
//
// Permitted to the AUTHOR or to anyone who moderates the channel — for messages
// a person wrote. Server-authored notices (IsServerAuthoredKind) are refused for
// everyone. The author clause is checked first and separately from
// `requireChannelManager` so an ordinary member can always retract their own
// message without being able to touch anybody else's.
func (s *Store) DeleteChannelMessageForAll(
	ctx context.Context, orgID, callerID, messageID string, claimRoles []string,
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

		// Read the row FIRST — an org_admin moderating a channel they are not in is
		// explicitly supported (see requireChannelManager), so membership cannot be
		// the gate here the way it is for hide and react.
		var channelID, senderID, kind string
		err = tx.QueryRow(ctx,
			`SELECT channel_id, sender_id, kind FROM channel_messages WHERE id = $1 AND org_id = $2`,
			messageID, orgID).Scan(&channelID, &senderID, &kind)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}

		// A server-authored notice (created / renamed / member added / forward
		// notice …) is a record of what happened, not something its sender said:
		// sender_id on it is only who caused the write, so neither being that
		// sender NOR moderating the channel lets anyone erase it through this
		// path. ErrForbidden is the same answer a missing id gets, so the
		// response does not reveal which ids are notices.
		if IsServerAuthoredKind(kind) {
			return ErrForbidden
		}

		if senderID != callerID {
			// Not the author: this is a moderation action, and must be authorized
			// as one. Unbounded in time for the same reason the DM path is — a
			// retraction window is a policy nobody has asked for, and inventing one
			// would be worse than not having it.
			if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
				return err
			}
		}

		// Idempotent: re-deleting keeps the FIRST timestamp and the FIRST deleter
		// rather than rewriting who did it.
		if _, err = tx.Exec(ctx, `
			UPDATE channel_messages
			SET deleted_for_all_at = COALESCE(deleted_for_all_at, now()),
			    deleted_by         = COALESCE(deleted_by, $2)
			WHERE id = $1`,
			messageID, callerID); err != nil {
			return err
		}

		// A pinned message that gets deleted must not stay pinned — the pin would
		// hold a tombstone at the top of the channel forever.
		if _, err = tx.Exec(ctx,
			`UPDATE channel_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`,
			messageID); err != nil {
			return err
		}

		members, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		evt := events.ChannelMessageDeleted{
			Type:       events.TypeChannelMessageDeleted,
			EventID:    uuid.Must(uuid.NewV7()).String(),
			OrgID:      orgID,
			OccurredAt: nowISO(),
			ChannelID:  channelID,
			MessageID:  messageID,
			DeletedBy:  callerID,
			Members:    members,
		}
		if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// deletedChannelMessageRow is one row DeleteChannelMessagesForAll's set-based
// UPDATE touched (or left alone because it was already deleted).
type deletedChannelMessageRow struct {
	id         string
	wasDeleted bool
}

// channelMessageDeletedEvents builds one ChannelMessageDeleted payload per
// row that was NEWLY tombstoned by this call — mirrors messageDeletedEvents
// in message_actions.go for the same reason: a retry must not re-emit an
// event for a message it did not actually just change.
func channelMessageDeletedEvents(orgID, channelID, deletedBy string, members []string, rows []deletedChannelMessageRow) []any {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		if r.wasDeleted {
			continue
		}
		out = append(out, events.ChannelMessageDeleted{
			Type:       events.TypeChannelMessageDeleted,
			EventID:    uuid.Must(uuid.NewV7()).String(),
			OrgID:      orgID,
			OccurredAt: nowISO(),
			ChannelID:  channelID,
			MessageID:  r.id,
			DeletedBy:  deletedBy,
			Members:    members,
		})
	}
	return out
}

// DeleteChannelMessagesForAll is the batch form of DeleteChannelMessageForAll:
// tombstones every id in messageIDs this caller may delete, in ONE set-based
// statement. The moderator check runs ONCE, up front — a moderator's batch
// may authorize every selected message, an ordinary member's only their own —
// rather than asking "am I allowed to touch THIS one" per row.
//
// Ids the caller may not delete — someone else's message when the caller is
// not a moderator, an id from another channel, or one that does not exist —
// come back in Skipped rather than failing the whole request, for the same
// reason DeleteMessagesForAll does: the rest of the selection may still be
// authorized. channelManagerCheck itself still returns ErrForbidden outright
// for a channel that does not exist or belongs to another org — that is not a
// partial result.
func (s *Store) DeleteChannelMessagesForAll(
	ctx context.Context, orgID, callerID, channelID string, messageIDs []string, claimRoles []string,
) (*BulkDeleteResult, error) {
	var out *BulkDeleteResult
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		isManager, err := channelManagerCheck(ctx, tx, orgID, channelID, callerID, claimRoles)
		if err != nil {
			return err
		}

		// A moderator's ($4=true) predicate authorizes every id in this
		// channel; a plain member's authorizes only their own. Folded into one
		// parameterized statement rather than two separate SQL strings so the
		// two paths cannot drift apart. Same COALESCE/was_deleted idempotency
		// shape as the DM path, plus unpinning: a pinned message that gets
		// deleted must not hold a tombstone at the top of the channel forever.
		rows, err := tx.Query(ctx, `
			WITH target AS (
				SELECT id, (deleted_for_all_at IS NOT NULL) AS was_deleted
				FROM channel_messages
				WHERE id = ANY($1::uuid[])
				  AND channel_id = $2
				  AND org_id = $3
				  AND ($4::boolean OR sender_id = $5)
				  -- Server-authored notices are never deletable here, whoever the
				  -- sender is and whether or not the caller moderates: ids that
				  -- fail this land in Skipped like any other id the caller may
				  -- not delete. The client list is the single source of truth
				  -- (clientMessageKinds), so a new server-only kind is protected
				  -- without touching this query.
				  AND kind = ANY($6::text[])
				FOR UPDATE
			), upd AS (
				UPDATE channel_messages m
				SET deleted_for_all_at = COALESCE(m.deleted_for_all_at, now()),
				    deleted_by         = COALESCE(m.deleted_by, $5),
				    pinned_at          = NULL,
				    pinned_by          = NULL
				FROM target t
				WHERE m.id = t.id
			)
			SELECT t.id::text, t.was_deleted FROM target t`,
			messageIDs, channelID, orgID, isManager, callerID, clientMessageKinds)
		if err != nil {
			return err
		}
		var deleted []deletedChannelMessageRow
		got := make(map[string]struct{}, len(messageIDs))
		for rows.Next() {
			var r deletedChannelMessageRow
			if err := rows.Scan(&r.id, &r.wasDeleted); err != nil {
				rows.Close()
				return err
			}
			deleted = append(deleted, r)
			got[r.id] = struct{}{}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		skipped := make([]string, 0, len(messageIDs))
		deletedIDs := make([]string, 0, len(deleted))
		for _, id := range messageIDs {
			if _, ok := got[id]; ok {
				deletedIDs = append(deletedIDs, id)
			} else {
				skipped = append(skipped, id)
			}
		}

		members, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}

		if err := insertOutboxBatch(ctx, tx, channelID,
			channelMessageDeletedEvents(orgID, channelID, callerID, members, deleted)); err != nil {
			return err
		}

		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = &BulkDeleteResult{Deleted: deletedIDs, Skipped: skipped}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SetChannelMessagePin pins (on=true) or unpins a channel message for everyone.
//
// MODERATOR ONLY — owner, channel admin, or org_admin. A pin changes what the
// whole channel sees, so it is a moderation capability rather than a personal
// one; a member who wants a message kept for themselves has the message itself.
func (s *Store) SetChannelMessagePin(
	ctx context.Context, orgID, callerID, messageID string, on bool, claimRoles []string,
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

		var channelID string
		var deletedAt *string
		err = tx.QueryRow(ctx,
			`SELECT channel_id, deleted_for_all_at::text FROM channel_messages
			 WHERE id = $1 AND org_id = $2`,
			messageID, orgID).Scan(&channelID, &deletedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
			return err
		}
		// Pinning a tombstone would put "this message was deleted" at the top of the
		// channel, which is noise rather than moderation.
		if on && deletedAt != nil {
			return ErrForbidden
		}

		// Idempotent both ways: pinning an already-pinned message keeps the original
		// timestamp so it does not jump to the front of the pinned list.
		if on {
			_, err = tx.Exec(ctx, `
				UPDATE channel_messages
				SET pinned_at = COALESCE(pinned_at, now()),
				    pinned_by = COALESCE(pinned_by, $2)
				WHERE id = $1`, messageID, callerID)
		} else {
			_, err = tx.Exec(ctx,
				`UPDATE channel_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`,
				messageID)
		}
		if err != nil {
			return err
		}

		members, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		evt := events.ChannelMessagePinned{
			Type:       events.TypeChannelMessagePinned,
			EventID:    uuid.Must(uuid.NewV7()).String(),
			OrgID:      orgID,
			OccurredAt: nowISO(),
			ChannelID:  channelID,
			MessageID:  messageID,
			Pinned:     on,
			ActorID:    callerID,
			Members:    members,
		}
		if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// SetChannelReaction adds or removes one emoji from one member on one channel
// message, returning that message's fresh tally from the caller's point of view.
//
// Same toggle-by-primary-key construction as the DM path: (message_id, user_id,
// emoji) IS the uniqueness rule, so both directions are idempotent with no
// read-modify-write and no lost update when two devices race.
func (s *Store) SetChannelReaction(
	ctx context.Context, orgID, callerID, messageID, emoji string, on bool,
) ([]ReactionDTO, error) {
	var out []ReactionDTO
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		channelID, err := channelForMessage(ctx, tx, orgID, messageID, callerID)
		if err != nil {
			return err
		}

		if on {
			_, err = tx.Exec(ctx, `
				INSERT INTO message_reactions (message_id, user_id, org_id, emoji)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
				messageID, callerID, orgID, emoji)
		} else {
			_, err = tx.Exec(ctx, `
				DELETE FROM message_reactions
				WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
				messageID, callerID, emoji)
		}
		if err != nil {
			return err
		}

		members, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		evt := events.ChannelMessageReaction{
			Type:       events.TypeChannelMessageReaction,
			EventID:    uuid.Must(uuid.NewV7()).String(),
			OrgID:      orgID,
			OccurredAt: nowISO(),
			ChannelID:  channelID,
			MessageID:  messageID,
			ActorID:    callerID,
			Members:    members,
		}
		if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
			return err
		}

		out, err = reactionsFor(ctx, tx, []string{messageID}, callerID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ReactionsForChannel tallies reactions for ONE PAGE of a channel, so the
// bubbles and their chips arrive together instead of the chips popping in after.
//
// Takes the same (beforeSeq, limit) window as ChannelMessages and must be called
// with the same values — tallying the whole channel would reintroduce an
// unbounded read alongside a paginated one, which is the bug
// ReactionsForConversation's comment records for the DM side.
func (s *Store) ReactionsForChannel(
	ctx context.Context, orgID, callerID, channelID string,
	beforeSeq int64, limit int,
) ([]ReactionDTO, error) {
	limit = clampMessagePage(limit)
	beforeSeq = beforeSeqOrNewest(beforeSeq)

	var out []ReactionDTO
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx,
			`SELECT id FROM channel_messages
			 WHERE channel_id = $1 AND seq < $2
			 ORDER BY seq DESC LIMIT $3`,
			channelID, beforeSeq, limit)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		out, err = reactionsFor(ctx, tx, ids, callerID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
