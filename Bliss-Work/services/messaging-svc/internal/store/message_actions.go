package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// Deleting a message, and reacting to one.
//
// ── Two deletions, deliberately not one ──────────────────────────────────────
// "Delete for me" is a fact about ONE READER: a row in message_hides, invisible
// to anyone else, available to either party for any message.
// "Delete for everyone" is a fact about THE MESSAGE: one timestamp, seen by
// both, and only its author may set it.
//
// Both are SOFT. The row has to survive: `seq` is the conversation's ordering
// key, and message_delivery references the id — a hard delete would punch a
// hole in the sequence and orphan the receipts. Keeping it
// is also the honest thing to render: the reader sees "this message was
// deleted" where the message was, instead of a gap that silently rewrites what
// they remember reading.

// HideMessage hides one message from ONE user's view. Either party may hide
// any message in a conversation they belong to. Idempotent.
func (s *Store) HideMessage(ctx context.Context, orgID, callerID, messageID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Membership check via the conversation, so a caller cannot hide a
		// message in someone else's chat (which would be a cheap way to probe
		// whether a message id exists).
		var convID string
		err := tx.QueryRow(ctx, `
			SELECT m.conversation_id
			FROM messages m
			JOIN conversation_members cm
			  ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
			WHERE m.id = $1 AND m.org_id = $3`,
			messageID, callerID, orgID).Scan(&convID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO message_hides (message_id, user_id, org_id)
			VALUES ($1, $2, $3)
			ON CONFLICT (message_id, user_id) DO NOTHING`,
			messageID, callerID, orgID)
		return err
	})
}

// ClearConversation hides every message in one DM for this caller only.
func (s *Store) ClearConversation(ctx context.Context, orgID, callerID, convID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var member bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM conversation_members
				WHERE conversation_id = $1 AND user_id = $2
			)`, convID, callerID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return ErrForbidden
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO message_hides (message_id, user_id, org_id)
			SELECT id, $2, $3 FROM messages WHERE conversation_id = $1
			ON CONFLICT (message_id, user_id) DO NOTHING`, convID, callerID, orgID)
		return err
	})
}

// DeleteMessageForAll tombstones a message for both parties. SENDER ONLY.
//
// Emits MessageDeleted so the other side's open thread swaps the bubble for a
// tombstone immediately — a delete the recipient only learns about on their
// next refetch is one they may well screenshot first.
func (s *Store) DeleteMessageForAll(ctx context.Context, orgID, callerID, messageID string) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		var convID, senderID string
		var threadID *string
		err = tx.QueryRow(ctx,
			`SELECT conversation_id, sender_id, thread_id FROM messages
			 WHERE id = $1 AND org_id = $2`,
			messageID, orgID).Scan(&convID, &senderID, &threadID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		// Only the author. Unbounded in time on purpose: a time limit ("you may
		// unsend for 15 minutes") is a policy this product has not asked for, and
		// guessing one would be worse than not having it.
		if senderID != callerID {
			return ErrForbidden
		}

		// Idempotent: re-deleting keeps the FIRST timestamp rather than moving it.
		if _, err = tx.Exec(ctx, `
			UPDATE messages
			SET deleted_for_all_at = COALESCE(deleted_for_all_at, now()),
			    deleted_by         = COALESCE(deleted_by, $2)
			WHERE id = $1`,
			messageID, callerID); err != nil {
			return err
		}

		// Resolved before the projection write rather than after: the event needs
		// the members anyway, and the inbox_items UPDATE below needs them as its
		// partition key.
		members, err := conversationMemberIDs(ctx, tx, convID)
		if err != nil {
			return err
		}

		// The Inbox preview quotes the body, so a mail thread whose latest message
		// was just deleted would keep showing the deleted text in the feed.
		//
		// owner_user_id is NOT optional here: inbox_items is HASH-partitioned on it
		// (0003_threads_inbox.sql), so a predicate without it prunes nothing and
		// sequential-scans all 64 partitions to touch at most two rows.
		if threadID != nil {
			if _, err = tx.Exec(ctx, `
				UPDATE inbox_items
				SET preview = '', preview_enc = NULL, updated_at = now()
				WHERE owner_user_id = ANY($2::uuid[])
				  AND item_kind = 'THREAD' AND ref_id = $1`,
				*threadID, members); err != nil {
				return err
			}
		}

		evt := events.MessageDeleted{
			Type:           events.TypeMessageDeleted,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			MessageID:      messageID,
			DeletedBy:      callerID,
			Members:        members,
		}
		if threadID != nil {
			evt.ThreadID = threadID
		}
		if err := insertOutbox(ctx, tx, convID, evt); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// BulkDeleteResult reports what a bulk delete actually did. `Skipped` is
// deliberately reasonless: distinguishing "not yours" from "no such message"
// would turn this into an existence oracle for ids the caller cannot already
// see, the same restraint channelForMessage's own comment documents. One
// bucket is also all the UI needs to render "Deleted 8 of 10".
type BulkDeleteResult struct {
	Deleted []string
	Skipped []string
}

// deletedMessageRow is one row DeleteMessagesForAll's set-based UPDATE
// touched (or left alone because it was already deleted).
type deletedMessageRow struct {
	id         string
	threadID   *string
	wasDeleted bool
}

// messageDeletedEvents builds one MessageDeleted payload per row that was
// NEWLY tombstoned by this call — not the ones that were already deleted,
// which stay reported as Deleted (idempotent) but must not re-emit an event a
// retry would otherwise duplicate.
func messageDeletedEvents(orgID, convID, deletedBy string, members []string, rows []deletedMessageRow) []any {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		if r.wasDeleted {
			continue
		}
		evt := events.MessageDeleted{
			Type:           events.TypeMessageDeleted,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			MessageID:      r.id,
			DeletedBy:      deletedBy,
			Members:        members,
		}
		if r.threadID != nil {
			evt.ThreadID = r.threadID
		}
		out = append(out, evt)
	}
	return out
}

// DeleteMessagesForAll is the batch form of DeleteMessageForAll: tombstones
// every id in messageIDs the caller authored, in ONE set-based statement
// rather than one round trip per message — the same technique
// AddChannelMembers (channels.go) uses for bulk membership writes.
//
// Ids the caller did not send — someone else's message, an id from another
// conversation, or one that does not exist — come back in Skipped rather than
// failing the whole request: the rest of the selection may still be
// authorized, and refusing all of it over one id would be worse than
// reporting which ones did not go through. A caller who is not a member of
// convID AT ALL gets ErrForbidden instead — that is not a partial result, it
// is not being allowed to ask the question.
func (s *Store) DeleteMessagesForAll(
	ctx context.Context, orgID, callerID, convID string, messageIDs []string,
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

		var member bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM conversation_members
				WHERE conversation_id = $1 AND user_id = $2
			)`, convID, callerID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return ErrForbidden
		}

		// One statement authorizes, deletes, and reports in the same round trip:
		// ids in $1 absent from the result are exactly the ones this caller did
		// not send in THIS conversation — the set difference IS the
		// authorization report, with no separate pre-check query.
		//
		// COALESCE keeps re-deleting idempotent (first delete wins, same as
		// DeleteMessageForAll); was_deleted distinguishes a row this call just
		// tombstoned from one that already was, so a retry does not re-emit an
		// event for a message it did not actually just change.
		rows, err := tx.Query(ctx, `
			WITH target AS (
				SELECT id, thread_id, (deleted_for_all_at IS NOT NULL) AS was_deleted
				FROM messages
				WHERE id = ANY($1::uuid[])
				  AND conversation_id = $2
				  AND org_id = $4
				  AND sender_id = $3
				FOR UPDATE
			), upd AS (
				UPDATE messages m
				SET deleted_for_all_at = COALESCE(m.deleted_for_all_at, now()),
				    deleted_by         = COALESCE(m.deleted_by, $3)
				FROM target t
				WHERE m.id = t.id
			)
			SELECT t.id::text, t.thread_id::text, t.was_deleted FROM target t`,
			messageIDs, convID, callerID, orgID)
		if err != nil {
			return err
		}
		var deleted []deletedMessageRow
		got := make(map[string]struct{}, len(messageIDs))
		for rows.Next() {
			var r deletedMessageRow
			if err := rows.Scan(&r.id, &r.threadID, &r.wasDeleted); err != nil {
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

		members, err := conversationMemberIDs(ctx, tx, convID)
		if err != nil {
			return err
		}

		// Batch-blank the Inbox preview for every distinct thread a NEWLY
		// deleted message belongs to — the batch form of DeleteMessageForAll's
		// per-message UPDATE, same reasoning (a mail thread whose latest
		// message was just deleted must not keep showing the deleted text).
		threadIDs := make([]string, 0, len(deleted))
		for _, r := range deleted {
			if !r.wasDeleted && r.threadID != nil {
				threadIDs = append(threadIDs, *r.threadID)
			}
		}
		if len(threadIDs) > 0 {
			if _, err := tx.Exec(ctx, `
				UPDATE inbox_items
				SET preview = '', preview_enc = NULL, updated_at = now()
				WHERE owner_user_id = ANY($2::uuid[])
				  AND item_kind = 'THREAD' AND ref_id = ANY($1::uuid[])`,
				threadIDs, members); err != nil {
				return err
			}
		}

		if err := insertOutboxBatch(ctx, tx, convID,
			messageDeletedEvents(orgID, convID, callerID, members, deleted)); err != nil {
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

// conversationMemberIDs lists both sides of a 1:1, so the gateway can route an
// event to each without a second lookup.
func conversationMemberIDs(ctx context.Context, tx pgx.Tx, convID string) ([]string, error) {
	rows, err := tx.Query(ctx,
		`SELECT user_id FROM conversation_members WHERE conversation_id = $1`, convID)
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

// ── Reactions ────────────────────────────────────────────────────────────────

// SetReaction adds (on=true) or removes (on=false) one emoji from one user on
// one message. Both directions are idempotent by construction — the primary key
// (message_id, user_id, emoji) IS the uniqueness rule, so a toggle is an INSERT
// … ON CONFLICT DO NOTHING or a DELETE, with no read-modify-write and therefore
// no lost update when two devices race.
func (s *Store) SetReaction(ctx context.Context, orgID, callerID, messageID, emoji string, on bool) ([]ReactionDTO, error) {
	var out []ReactionDTO
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Same membership gate as HideMessage: you may only react inside a
		// conversation you are part of.
		var convID string
		err := tx.QueryRow(ctx, `
			SELECT m.conversation_id
			FROM messages m
			JOIN conversation_members cm
			  ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
			WHERE m.id = $1 AND m.org_id = $3`,
			messageID, callerID, orgID).Scan(&convID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
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

		// Tell the other side. The payload deliberately carries no counts: the
		// tally is per-viewer (`mine` differs), so each client refetches its own
		// rather than trying to apply someone else's numbers.
		members, err := conversationMemberIDs(ctx, tx, convID)
		if err != nil {
			return err
		}
		evt := events.MessageReaction{
			Type:           events.TypeMessageReaction,
			EventID:        uuid.Must(uuid.NewV7()).String(),
			OrgID:          orgID,
			OccurredAt:     nowISO(),
			ConversationID: convID,
			MessageID:      messageID,
			ActorID:        callerID,
			Members:        members,
		}
		if err := insertOutbox(ctx, tx, convID, evt); err != nil {
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

// ReactionDTO is one emoji's tally on one message, from the caller's point of
// view. `Mine` is what lets the UI render the chip as pressed.
type ReactionDTO struct {
	MessageID string `json:"messageId"`
	Emoji     string `json:"emoji"`
	Count     int    `json:"count"`
	Mine      bool   `json:"mine"`
	// Reactors names the people behind Count, newest reaction last, CAPPED at
	// maxReactorNames. Count stays authoritative: on a chip with more reactors
	// than the cap the list is a sample and the client says so, rather than the
	// tally quietly shrinking to the number of names that fit.
	Reactors []string `json:"reactors,omitempty"`
}

// How many names one chip ships. A reaction chip is read at a glance and its
// popup is a list, so past a few dozen the names stop being information and
// start being payload — on the hottest read in the app, once per chip, per
// message, per page.
//
// A string because the only place it is used is the array slice bound inside
// reactionColumns, and a Go int would have to be formatted into that at runtime
// to say the same thing twice.
const maxReactorNames = "50"

// reactionColumns is the SELECT list both reaction readers use, in exactly the
// order scanReactions expects. Shared as a constant for the same reason
// messageColumns is: one projection between two readers cannot drift into a
// scan-order bug that only shows up at runtime.
//
// The count alone answers "how many", which in a channel is the less useful
// half of the question — a chip reading 3 with no way to find out who is a chip
// you have to ask about out loud. The slice bound is applied in SQL so the
// names are dropped before they cross the wire.
const reactionColumns = `
	r.message_id, r.emoji, count(*)::int,
	bool_or(r.user_id = $2) AS mine,
	(array_agg(
	    COALESCE(NULLIF(up.display_name, ''), up.username, '')
	    ORDER BY r.created_at
	))[1:` + maxReactorNames + `] AS reactors`

// reactionNameJoin pairs with reactionColumns. LEFT, because a reaction from
// somebody with no projection row yet is still a reaction — it renders with an
// empty name rather than dropping the tally it belongs to.
const reactionNameJoin = `
	LEFT JOIN user_projection up ON up.user_id = r.user_id`

// reactionGrouping pairs with reactionColumns: same grouping key, and the chip
// order the UI renders left to right (commonest first, then stable by emoji).
const reactionGrouping = `
	GROUP BY r.message_id, r.emoji
	ORDER BY r.message_id, count(*) DESC, r.emoji ASC`

// scanReactions drains a reactionColumns cursor and closes it.
func scanReactions(rows pgx.Rows) ([]ReactionDTO, error) {
	defer rows.Close()
	out := []ReactionDTO{}
	for rows.Next() {
		var r ReactionDTO
		if err := rows.Scan(&r.MessageID, &r.Emoji, &r.Count, &r.Mine, &r.Reactors); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// reactionsFor tallies reactions across a whole page of messages in ONE query.
// Per-message queries would be N+1 on the hottest read in the app.
func reactionsFor(ctx context.Context, tx pgx.Tx, messageIDs []string, callerID string) ([]ReactionDTO, error) {
	if len(messageIDs) == 0 {
		return []ReactionDTO{}, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT`+reactionColumns+`
		FROM message_reactions r`+reactionNameJoin+`
		WHERE r.message_id = ANY($1)`+reactionGrouping,
		messageIDs, callerID)
	if err != nil {
		return nil, err
	}
	return scanReactions(rows)
}

// ReactionsForConversation tallies reactions for ONE PAGE of a conversation the
// caller belongs to, so the message list and its reactions arrive together
// instead of the bubbles rendering first and the chips popping in afterwards.
//
// Takes the same (beforeSeq, limit) window as ListMessages and must be called
// with the same values: it previously tallied every reaction in the whole
// conversation, which quietly reintroduced an unbounded read on the side of a
// paginated one — the client rendered 50 bubbles while downloading reaction
// tallies for all fifty thousand.
func (s *Store) ReactionsForConversation(
	ctx context.Context, orgID, callerID, convID string,
	beforeSeq int64, limit int,
) ([]ReactionDTO, error) {
	limit = clampMessagePage(limit)
	beforeSeq = beforeSeqOrNewest(beforeSeq)

	var out []ReactionDTO
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var present int
		err := tx.QueryRow(ctx,
			`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
			convID, callerID).Scan(&present)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		// The CTE resolves the same page of message ids ListMessages would
		// return for this window, so the join can only tally reactions the
		// client is actually about to render.
		rows, err := tx.Query(ctx, `
			WITH page AS (
			    SELECT m.id
			    FROM messages m
			    WHERE m.conversation_id = $1 AND m.seq < $3
			    ORDER BY m.seq DESC
			    LIMIT $4
			)
			SELECT`+reactionColumns+`
			FROM message_reactions r
			JOIN page p ON p.id = r.message_id`+reactionNameJoin+reactionGrouping,
			convID, callerID, beforeSeq, limit)
		if err != nil {
			return err
		}
		out, err = scanReactions(rows)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
