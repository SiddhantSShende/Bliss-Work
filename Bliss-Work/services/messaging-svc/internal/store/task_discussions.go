// task_discussions.go — the "Chat" button's backend: resolving a task-svc
// task to the messaging-svc conversation/thread (DM) or channel it should
// open, and the task-specific unread count the desktop sticky widget badges.
//
// task-svc and messaging-svc do not share a database, so task_id here is an
// opaque id the caller supplies (the task DTO it already has) — never looked
// up or validated against task-svc. Authorization for the DISCUSSION itself
// is therefore the ordinary conversation/channel membership check: creating
// or reading a task_discussions row grants no visibility beyond what being a
// DM participant or channel member already grants.
package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// ErrTaskDiscussionTargetRequired: OpenTaskDiscussion needs exactly one of
// peerID/channelID, never both and never neither.
var ErrTaskDiscussionTargetRequired = errors.New("exactly one of peerId or channelId is required")

const (
	TaskDiscussionKindDM      = "DM"
	TaskDiscussionKindChannel = "CHANNEL"
)

// TaskDiscussionDTO is one task's resolved chat target.
type TaskDiscussionDTO struct {
	ID             string  `json:"id"`
	TaskID         string  `json:"taskId"`
	Kind           string  `json:"kind"`
	ConversationID *string `json:"conversationId,omitempty"`
	ThreadID       *string `json:"threadId,omitempty"`
	ChannelID      *string `json:"channelId,omitempty"`
}

// TaskDiscussionSummaryDTO adds the caller's unread count, for the bulk
// GET /tasks/discussions the sticky widget/task list use to badge every
// visible task in one round trip instead of one call per task.
type TaskDiscussionSummaryDTO struct {
	TaskDiscussionDTO
	UnreadCount int64 `json:"unreadCount"`
}

// OpenTaskDiscussion ensures taskID's chat target exists and is visible to
// the caller, without sending anything — mirrors OpenConversation's own
// "navigate to an empty thread, don't fabricate a greeting" shape. Exactly
// one of peerID/channelID must be set. Idempotent: a second call (e.g. two
// concurrent "Chat" clicks) returns the same row — see the partial unique
// indexes in 0035_task_discussions.sql.
func (s *Store) OpenTaskDiscussion(ctx context.Context, orgID, callerID, taskID string, peerID, channelID *string) (TaskDiscussionDTO, error) {
	switch {
	case peerID != nil && channelID != nil:
		return TaskDiscussionDTO{}, ErrTaskDiscussionTargetRequired
	case peerID == nil && channelID == nil:
		return TaskDiscussionDTO{}, ErrTaskDiscussionTargetRequired
	case peerID != nil:
		return s.openTaskDiscussionDM(ctx, orgID, callerID, taskID, *peerID)
	default:
		return s.openTaskDiscussionChannel(ctx, orgID, callerID, taskID, *channelID)
	}
}

func (s *Store) openTaskDiscussionDM(ctx context.Context, orgID, callerID, taskID, peerID string) (TaskDiscussionDTO, error) {
	// OpenConversation applies its own org/self checks (ErrForbidden on a
	// cross-org peer or peerID == callerID), so there is nothing left for this
	// function to validate before it.
	convID, err := s.OpenConversation(ctx, orgID, callerID, peerID)
	if err != nil {
		return TaskDiscussionDTO{}, err
	}
	var d TaskDiscussionDTO
	err = s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		newID := uuid.Must(uuid.NewV7()).String()
		if _, err := tx.Exec(ctx,
			`INSERT INTO task_discussions (id, org_id, task_id, kind, conversation_id, created_by)
			 VALUES ($1, $2, $3, 'DM', $4, $5)
			 ON CONFLICT (task_id, conversation_id) WHERE kind = 'DM' DO NOTHING`,
			newID, orgID, taskID, convID, callerID); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT id, thread_id FROM task_discussions
			 WHERE task_id = $1 AND conversation_id = $2 AND kind = 'DM'`,
			taskID, convID).Scan(&d.ID, &d.ThreadID)
	})
	if err != nil {
		return TaskDiscussionDTO{}, err
	}
	d.TaskID = taskID
	d.Kind = TaskDiscussionKindDM
	d.ConversationID = &convID
	return d, nil
}

func (s *Store) openTaskDiscussionChannel(ctx context.Context, orgID, callerID, taskID, channelID string) (TaskDiscussionDTO, error) {
	var d TaskDiscussionDTO
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		newID := uuid.Must(uuid.NewV7()).String()
		if _, err := tx.Exec(ctx,
			`INSERT INTO task_discussions (id, org_id, task_id, kind, channel_id, created_by)
			 VALUES ($1, $2, $3, 'CHANNEL', $4, $5)
			 ON CONFLICT (task_id, channel_id) WHERE kind = 'CHANNEL' DO NOTHING`,
			newID, orgID, taskID, channelID, callerID); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT id FROM task_discussions WHERE task_id = $1 AND channel_id = $2 AND kind = 'CHANNEL'`,
			taskID, channelID).Scan(&d.ID)
	})
	if err != nil {
		return TaskDiscussionDTO{}, err
	}
	d.TaskID = taskID
	d.Kind = TaskDiscussionKindChannel
	d.ChannelID = &channelID
	return d, nil
}

// BulkTaskDiscussions returns the discussion + unread count for every task in
// taskIDs the caller can actually see — a DM row only if the caller is a
// member of its conversation, a CHANNEL row only if the caller is a member of
// its channel. A task with no discussion yet (nobody has clicked Chat) is
// simply absent from the result; the caller's own task list already knows
// which tasks exist. Two queries total (one per kind), batched with
// `= ANY($taskIDs)`, so a task list of any size costs two round trips rather
// than one per task.
func (s *Store) BulkTaskDiscussions(ctx context.Context, orgID, callerID string, taskIDs []string) ([]TaskDiscussionSummaryDTO, error) {
	if len(taskIDs) == 0 {
		return []TaskDiscussionSummaryDTO{}, nil
	}
	out := []TaskDiscussionSummaryDTO{}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// DM rows. Unread mirrors GetThread's own subquery (threads.go): messages
		// in the resolved thread, from the peer, newer than my last_read_seq. 0
		// while thread_id is still NULL — nothing has been sent into this
		// discussion yet, so there is nothing to have missed.
		rows, err := tx.Query(ctx, `
			SELECT td.id, td.task_id, td.conversation_id, td.thread_id,
			       COALESCE((
			           SELECT count(*) FROM messages m
			           WHERE m.thread_id = td.thread_id AND m.sender_id <> $3
			             AND m.seq > COALESCE(tm.last_read_seq, 0)
			       ), 0) AS unread
			FROM task_discussions td
			JOIN conversation_members cm ON cm.conversation_id = td.conversation_id AND cm.user_id = $3
			LEFT JOIN thread_members tm ON tm.thread_id = td.thread_id AND tm.user_id = $3
			WHERE td.org_id = $1 AND td.kind = 'DM' AND td.task_id = ANY($2::uuid[])`,
			orgID, taskIDs, callerID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var d TaskDiscussionSummaryDTO
			d.Kind = TaskDiscussionKindDM
			if err := rows.Scan(&d.ID, &d.TaskID, &d.ConversationID, &d.ThreadID, &d.UnreadCount); err != nil {
				rows.Close()
				return err
			}
			out = append(out, d)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// CHANNEL rows. Unread = messages tagged with this task, newer than my
		// channel read cursor, not my own — the channel twin of the DM subquery
		// above, backed by idx_channel_messages_channel_task_seq (0036).
		rows, err = tx.Query(ctx, `
			SELECT td.id, td.task_id, td.channel_id,
			       COALESCE((
			           SELECT count(*) FROM channel_messages cmsg
			           WHERE cmsg.channel_id = td.channel_id AND cmsg.task_id = td.task_id
			             AND cmsg.sender_id <> $3 AND cmsg.seq > cm.last_read_seq
			       ), 0) AS unread
			FROM task_discussions td
			JOIN channel_members cm ON cm.channel_id = td.channel_id AND cm.user_id = $3
			WHERE td.org_id = $1 AND td.kind = 'CHANNEL' AND td.task_id = ANY($2::uuid[])`,
			orgID, taskIDs, callerID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var d TaskDiscussionSummaryDTO
			d.Kind = TaskDiscussionKindChannel
			if err := rows.Scan(&d.ID, &d.TaskID, &d.ChannelID, &d.UnreadCount); err != nil {
				rows.Close()
				return err
			}
			out = append(out, d)
		}
		rows.Close()
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SendTaskDiscussionMessage sends body as part of taskID's DM discussion with
// peerID, creating the discussion and/or its underlying thread on first use.
//
// The discussion has no thread yet right after OpenTaskDiscussion — a thread
// needs a root message. The first send therefore goes through SendMessage,
// which always mints a BRAND NEW thread for a top-level send regardless of
// whatever other history this DM already has (see appendMessageTx: "parentMessageID
// == "" + threadIDHint == "" → top-level send (new thread)") — exactly the
// "this task gets its own thread" behaviour wanted here, not a reuse of the
// pair's general chat thread. thread_id is then backfilled onto the
// discussion row. A later send reuses that thread via ReplyToThread.
// Idempotent on clientMsgID exactly as SendMessage/ReplyToThread already are;
// this adds no second dedupe layer.
func (s *Store) SendTaskDiscussionMessage(ctx context.Context, orgID, callerID, taskID, peerID, body, clientMsgID string) (*SendResult, error) {
	disc, err := s.openTaskDiscussionDM(ctx, orgID, callerID, taskID, peerID)
	if err != nil {
		return nil, err
	}
	if disc.ThreadID != nil {
		return s.ReplyToThread(ctx, orgID, callerID, *disc.ThreadID, "", body, clientMsgID, "")
	}
	res, err := s.SendMessage(ctx, orgID, callerID, peerID, body, clientMsgID, SendOptions{})
	if err != nil {
		return nil, err
	}
	if res.ThreadID != "" {
		// Best-effort conditional backfill. If two devices send the very first
		// task message at the same instant, each independently mints its own
		// thread via SendMessage above — no message is lost either way — and
		// only the first of these two UPDATEs wins; the loser's thread simply
		// never becomes this discussion's thread_id. Rare and harmless enough
		// not to warrant a cross-transaction lock spanning two separate stores'
		// worth of work (OpenTaskDiscussion's tx already committed by now).
		_ = s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx,
				`UPDATE task_discussions SET thread_id = $2 WHERE id = $1 AND thread_id IS NULL`,
				disc.ID, res.ThreadID)
			return err
		})
	}
	return res, nil
}

// SendChannelTaskMessage sends body into channelID, tagged with taskID, as
// part of that task's channel discussion.
//
// A small sibling of SendChannelMessage (channels.go) rather than an added
// parameter there: this path never needs SendChannelMessage's kind/replyTo/
// attachmentID handling, and that function's existing 8-argument signature is
// called directly by ten pre-existing test files — threading an optional
// taskID through it would touch every one of them for a feature none of them
// exercises. Mirrors its idempotency (INSERT ... ON CONFLICT DO NOTHING on
// the same (channel_id, sender_id, client_msg_id) unique constraint) and its
// membership/block gates exactly.
func (s *Store) SendChannelTaskMessage(ctx context.Context, orgID, callerID, taskID, channelID, body, clientMsgID string) (*ChannelSendResult, error) {
	// Ensure the discussion row exists (same idempotent upsert OpenTaskDiscussion
	// uses) so BulkTaskDiscussions can find this task's channel discussion even
	// when the caller sent straight in without ever calling Open first — and so
	// the membership gate below is NOT the only thing standing between a
	// non-member and tagging a channel they cannot see.
	if _, err := s.openTaskDiscussionChannel(ctx, orgID, callerID, taskID, channelID); err != nil {
		return nil, err
	}
	var out *ChannelSendResult
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		if blocked, err := isBlocked(ctx, tx, channelID, callerID); err != nil {
			return err
		} else if blocked {
			return ErrForbidden
		}

		var existingID string
		var existingSeq int64
		err = tx.QueryRow(ctx,
			`SELECT id, seq FROM channel_messages WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
			channelID, callerID, clientMsgID).Scan(&existingID, &existingSeq)
		if err == nil {
			if cerr := tx.Commit(ctx); cerr != nil {
				return cerr
			}
			out = &ChannelSendResult{MessageID: existingID, Seq: existingSeq}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		var seq int64
		if err := tx.QueryRow(ctx,
			`UPDATE channels SET seq_counter = seq_counter + 1, last_msg_at = now()
			 WHERE id = $1 RETURNING seq_counter`, channelID).Scan(&seq); err != nil {
			return err
		}
		bodyEnc, err := s.crypto.Encrypt(ctx, tx, orgID, body)
		if err != nil {
			return err
		}
		msgID := uuid.Must(uuid.NewV7()).String()
		tag, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, body_enc, client_msg_id, kind, task_id)
			 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)
			 ON CONFLICT (channel_id, sender_id, client_msg_id) DO NOTHING`,
			msgID, orgID, channelID, seq, callerID, bodyEnc, clientMsgID, MessageKindText, taskID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Lost the race to a concurrent send of this exact
			// (channel, sender, client_msg_id) — same pattern as
			// SendChannelMessage; the other transaction's row is the answer.
			if err := tx.QueryRow(ctx,
				`SELECT id, seq FROM channel_messages WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
				channelID, callerID, clientMsgID).Scan(&existingID, &existingSeq); err != nil {
				return err
			}
			if cerr := tx.Commit(ctx); cerr != nil {
				return cerr
			}
			out = &ChannelSendResult{MessageID: existingID, Seq: existingSeq}
			return nil
		}

		members, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		senderName, senderDisplay, err := s.cachedUserNames(ctx, tx, orgID, callerID)
		if err != nil {
			return err
		}
		var channelName string
		if err := tx.QueryRow(ctx, `SELECT name FROM channels WHERE id = $1`, channelID).Scan(&channelName); err != nil {
			return err
		}

		tid := taskID
		evt := events.ChannelMessageCreated{
			Type:              events.TypeChannelMessageCreated,
			EventID:           uuid.Must(uuid.NewV7()).String(),
			OrgID:             orgID,
			OccurredAt:        nowISO(),
			ChannelID:         channelID,
			MessageID:         msgID,
			Seq:               seq,
			SenderID:          callerID,
			SenderUsername:    senderName,
			SenderDisplayName: senderDisplay,
			ChannelName:       channelName,
			Body:              body,
			Members:           members,
			TaskID:            &tid,
		}
		if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = &ChannelSendResult{MessageID: msgID, Seq: seq}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
