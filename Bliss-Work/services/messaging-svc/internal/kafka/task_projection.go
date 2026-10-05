package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/shared-kafkaauth"
)

// task event type discriminants (mirrors packages/shared/src/types/events.ts).
const (
	typeTaskAssigned     = "task.assigned"
	typeTaskWithdrawn    = "task.withdrawn"
	typeTaskAcknowledged = "task.acknowledged"
	typeTaskCompleted    = "task.completed"
	typeTaskIgnored      = "task.ignored"
	typeTaskLeft         = "task.left"
	// task-svc's deadline sweeper: the deadline passed before the assignment was
	// completed. Shown on the inbox row as a MISSED badge.
	typeTaskMissed = "task.missed"
	// Internal-only (see packages/shared/src/types/events.ts's TaskDeleted):
	// an admin hard-deleted the task via task-svc's internal by-title endpoint.
	typeTaskDeleted = "task.deleted"
)

// TaskProjectionConsumer eagerly projects task.events.v1 into the messagingdb
// `inbox_items` table so the unified /inbox endpoint is a single keyset-paginated
// query against ONE table — no cross-service join at request time.
//
// Group: messaging-svc-inbox-tasks (separate from the existing AuthConsumer
// group so partition assignment + offset commit are independent).
//
// Dedup: dedicated consumed_events_inbox_tasks table — must NOT share with the
// existing per-event_id consumed_events used by AuthConsumer.
type TaskProjectionConsumer struct {
	store *store.Store
	log   *slog.Logger
	r     *kafka.Reader
}

// NewTaskProjectionConsumer builds the reader. brokers, log unchanged.
func NewTaskProjectionConsumer(st *store.Store, brokers []string, log *slog.Logger) *TaskProjectionConsumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "messaging-svc-inbox-tasks",
		Topic:          events.TopicTask,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: time.Second,
		// nil unless KAFKA_SECURITY_PROTOCOL asks for TLS/SASL, which is
		// exactly what ReaderConfig wants for an unauthenticated broker.
		Dialer: kafkaauth.Dialer(),
	})
	return &TaskProjectionConsumer{store: st, log: log, r: r}
}

// Run consumes until ctx is cancelled.
//
// FetchMessage + an explicit CommitMessages after a SUCCESSFUL handle — see
// consumer.go's Run for why: ReadMessage commits before returning whenever
// the reader belongs to a consumer group, which could commit an offset before
// the message behind it was ever actually applied. A failed message is retried
// in place (handleWithRetry) so a later commit cannot carry the offset past it.
func (c *TaskProjectionConsumer) Run(ctx context.Context) {
	defer c.r.Close()
	for {
		m, err := c.r.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			c.log.Error("task projector read failed", "err", err)
			// Same 1s backoff every other consumer in this codebase uses on a
			// FetchMessage error (see ws-gateway/internal/fanout/fanout.go's
			// Consumer.Run) — without it, a Kafka outage turns this into a
			// tight busy-loop that also floods the logs for its duration.
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			continue
		}
		if !handleWithRetry(ctx, c.log, "task projector", m, func(msgCtx context.Context) bool {
			return c.handleSafely(msgCtx, m.Value)
		}) {
			return // shutting down mid-retry: left uncommitted, so a restart redelivers it
		}
		if err := c.r.CommitMessages(ctx, m); err != nil {
			c.log.Error("task projector commit failed", "err", err)
		}
	}
}

// handleSafely recovers a panic in handle — see consumer.go's handleSafely
// for why a crash-loop is worse than logging and moving on to the next
// message. Reports false (do not commit) on a recovered panic.
func (c *TaskProjectionConsumer) handleSafely(ctx context.Context, value []byte) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			c.log.Error("task projector handler panicked", "panic", r)
			ok = false
		}
	}()
	return c.handle(ctx, value)
}

// taskEvent is the union envelope we partially decode for routing. Only the
// fields actually needed by the projector are extracted; everything else stays
// in the raw payload (forward-compatibility).
type taskEvent struct {
	Type           string `json:"type"`
	EventID        string `json:"eventId"`
	OrgID          string `json:"orgId"`
	OccurredAt     string `json:"occurredAt"`
	TaskID         string `json:"taskId"`
	AssigneeID     string `json:"assigneeId"`
	SenderID       string `json:"senderId"`
	StatusVersion  int64  `json:"statusVersion"`
	SenderUsername string `json:"senderUsername"`
	Title          string `json:"title"`
	Description    string `json:"description"`
}

// handle processes one message and reports whether its offset is safe to
// commit — see consumer.go's handle for the true/false contract.
func (c *TaskProjectionConsumer) handle(ctx context.Context, value []byte) bool {
	var evt taskEvent
	if err := json.Unmarshal(value, &evt); err != nil {
		c.log.Error("task projector bad json", "err", err)
		return true
	}
	switch evt.Type {
	case typeTaskAssigned, typeTaskWithdrawn, typeTaskAcknowledged, typeTaskCompleted, typeTaskIgnored, typeTaskLeft, typeTaskMissed, typeTaskDeleted:
		// supported
	default:
		return true
	}

	// Cheap pre-check, not a claim — see consumer.go's IsConsumed call for
	// why: claiming here instead of after a successful write would make a
	// genuine write failure indistinguishable from success on redelivery.
	done, err := c.store.IsConsumedInboxTasks(ctx, evt.EventID)
	if err != nil {
		c.log.Error("task projector dedup check failed", "eventId", evt.EventID, "err", err)
		return false
	}
	if done {
		return true
	}

	occurred, err := time.Parse(time.RFC3339Nano, evt.OccurredAt)
	if err != nil {
		// Fall back to now — clock-skewed events should still project, but
		// the monotonic guard in upsert means we never rewind.
		occurred = time.Now().UTC()
	}

	var werr error
	switch evt.Type {
	case typeTaskAssigned:
		werr = c.store.InsertTaskInboxItem(
			ctx, evt.OrgID, evt.AssigneeID, evt.TaskID, evt.SenderID,
			evt.Title, evt.Description, occurred,
		)
	case typeTaskWithdrawn:
		werr = c.store.DeleteTaskInboxItem(ctx, evt.AssigneeID, evt.TaskID, occurred)
	case typeTaskAcknowledged:
		werr = c.updateBadge(ctx, evt, occurred, "ACKNOWLEDGED")
	case typeTaskCompleted:
		werr = c.updateBadge(ctx, evt, occurred, "COMPLETED")
	case typeTaskLeft:
		werr = c.updateBadge(ctx, evt, occurred, "LEFT")
	case typeTaskMissed:
		werr = c.updateBadge(ctx, evt, occurred, "MISSED")
	case typeTaskIgnored:
		werr = c.store.HideTaskInboxItem(ctx, evt.AssigneeID, evt.TaskID, occurred)
	case typeTaskDeleted:
		werr = c.store.DeleteTaskInboxItem(ctx, evt.AssigneeID, evt.TaskID, occurred)
	}
	if werr != nil {
		c.log.Error("task projector write failed",
			"eventId", evt.EventID, "taskId", evt.TaskID, "type", evt.Type, "err", werr)
		return false
	}

	// Dedup AFTER the write, not before (separate table from AuthConsumer):
	// every write above is already an idempotent upsert, so a redelivery
	// replaying it is harmless — but marking consumed before a write that then
	// fails would make that failure permanent, since the redelivery this fix
	// exists to enable would just see the event already claimed and skip it.
	if _, err := c.store.MarkConsumedInboxTasks(ctx, evt.EventID); err != nil {
		c.log.Error("task projector dedup failed", "eventId", evt.EventID, "err", err)
		return false
	}
	return true
}

func (c *TaskProjectionConsumer) updateBadge(ctx context.Context, evt taskEvent, occurred time.Time, badge string) error {
	return c.store.UpdateTaskStatusBadge(ctx, evt.AssigneeID, evt.TaskID, badge, occurred)
}
