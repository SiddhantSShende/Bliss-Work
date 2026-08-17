package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/kafkaauth"
	"github.com/task-board/messaging-svc/internal/store"
)

// task event type discriminants (mirrors packages/shared/src/types/events.ts).
const (
	typeTaskAssigned     = "task.assigned"
	typeTaskAcknowledged = "task.acknowledged"
	typeTaskCompleted    = "task.completed"
	typeTaskIgnored      = "task.ignored"
	typeTaskLeft         = "task.left"
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
func (c *TaskProjectionConsumer) Run(ctx context.Context) {
	defer c.r.Close()
	for {
		m, err := c.r.ReadMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			c.log.Error("task projector read failed", "err", err)
			continue
		}
		msgCtx, span := startConsumeSpan(ctx, m)
		c.handle(msgCtx, m.Value)
		span.End()
	}
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

func (c *TaskProjectionConsumer) handle(ctx context.Context, value []byte) {
	var evt taskEvent
	if err := json.Unmarshal(value, &evt); err != nil {
		c.log.Error("task projector bad json", "err", err)
		return
	}
	switch evt.Type {
	case typeTaskAssigned, typeTaskAcknowledged, typeTaskCompleted, typeTaskIgnored, typeTaskLeft:
		// supported
	default:
		return
	}

	// Per-group dedup (separate table from AuthConsumer).
	fresh, err := c.store.MarkConsumedInboxTasks(ctx, evt.EventID)
	if err != nil {
		c.log.Error("task projector dedup failed", "eventId", evt.EventID, "err", err)
		return
	}
	if !fresh {
		return
	}

	occurred, err := time.Parse(time.RFC3339Nano, evt.OccurredAt)
	if err != nil {
		// Fall back to now — clock-skewed events should still project, but
		// the monotonic guard in upsert means we never rewind.
		occurred = time.Now().UTC()
	}

	switch evt.Type {
	case typeTaskAssigned:
		if err := c.store.InsertTaskInboxItem(
			ctx, evt.OrgID, evt.AssigneeID, evt.TaskID, evt.SenderID,
			evt.Title, evt.Description, occurred,
		); err != nil {
			c.log.Error("InsertTaskInboxItem failed",
				"eventId", evt.EventID, "taskId", evt.TaskID, "err", err)
		}
	case typeTaskAcknowledged:
		c.updateBadge(ctx, evt, occurred, "ACKNOWLEDGED")
	case typeTaskCompleted:
		c.updateBadge(ctx, evt, occurred, "COMPLETED")
	case typeTaskLeft:
		c.updateBadge(ctx, evt, occurred, "LEFT")
	case typeTaskIgnored:
		if err := c.store.HideTaskInboxItem(ctx, evt.AssigneeID, evt.TaskID, occurred); err != nil {
			c.log.Error("HideTaskInboxItem failed",
				"eventId", evt.EventID, "taskId", evt.TaskID, "err", err)
		}
	}
}

func (c *TaskProjectionConsumer) updateBadge(ctx context.Context, evt taskEvent, occurred time.Time, badge string) {
	if err := c.store.UpdateTaskStatusBadge(ctx, evt.AssigneeID, evt.TaskID, badge, occurred); err != nil {
		c.log.Error("UpdateTaskStatusBadge failed",
			"eventId", evt.EventID, "taskId", evt.TaskID, "badge", badge, "err", err)
	}
}
