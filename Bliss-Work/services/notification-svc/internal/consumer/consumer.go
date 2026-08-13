package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/notification-svc/internal/events"
	"github.com/task-board/notification-svc/internal/outbox"
	"github.com/task-board/notification-svc/internal/tracing"
)

// errMalformed marks a message whose payload could not be unmarshaled. It is the
// only error that routes a message to the dead-letter topic (and then commits);
// every other error is treated as transient and left uncommitted to redeliver.
var errMalformed = errors.New("malformed message")

// Consumer reads task.events.v1 and projects acknowledged/completed events into
// notifications plus a notification.created outbox row.
type Consumer struct {
	pool   *pgxpool.Pool
	reader *kafka.Reader
	dlq    *kafka.Writer
	log    *slog.Logger
}

// New constructs a Consumer subscribed to task.events.v1 under group
// "notification-svc".
func New(pool *pgxpool.Pool, brokers []string, log *slog.Logger) *Consumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "notification-svc",
		Topic:          events.TopicTask,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: 0, // commit synchronously after successful handling
		MaxWait:        500 * time.Millisecond,
	})
	// Dead-letter producer for poison (unparseable) messages.
	dlq := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        events.TopicNotificationDLQ,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		BatchTimeout: 50 * time.Millisecond,
	}
	return &Consumer{pool: pool, reader: r, dlq: dlq, log: log}
}

// Run consumes until ctx is cancelled. The loop body is wrapped so a panic in
// handling logs at ERROR and the loop continues instead of silently killing the
// goroutine.
func (c *Consumer) Run(ctx context.Context) {
	defer c.reader.Close()
	defer c.dlq.Close()
	for ctx.Err() == nil {
		c.runOnce(ctx)
	}
}

// runOnce fetches and processes a single message with panic recovery. The Kafka
// offset is committed ONLY after the message is fully handled (handler returned
// nil and its DB transaction committed). On a transient error the offset is left
// uncommitted so the message redelivers; on a malformed payload the raw bytes
// are dead-lettered and then committed so the poison pill cannot block the
// partition.
func (c *Consumer) runOnce(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			c.log.Error("consumer panic recovered; offset left uncommitted for redelivery", "panic", rec)
		}
	}()

	m, err := c.reader.FetchMessage(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		c.log.Error("fetch message failed", "error", err)
		time.Sleep(time.Second)
		return
	}

	// CONSUMER span as a child of the producer's injected trace context. With
	// tracing disabled the extracted context is empty and the span is a no-op.
	hdrs := m.Headers
	msgCtx := otel.GetTextMapPropagator().Extract(ctx, tracing.NewKafkaHeaderCarrier(&hdrs))
	msgCtx, span := otel.Tracer("kafka").Start(msgCtx, m.Topic+" process",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			semconv.MessagingSystemKafka,
			semconv.MessagingDestinationName(m.Topic),
			semconv.MessagingOperationName("process"),
		),
	)
	defer span.End()

	err = c.handle(msgCtx, m.Value)
	switch {
	case err == nil:
		// Fully handled (tx committed): safe to commit the offset.
	case errors.Is(err, errMalformed):
		// Poison message: dead-letter the raw bytes, then commit so it cannot
		// block the partition. If we cannot dead-letter, leave it uncommitted.
		if derr := c.deadLetter(ctx, m); derr != nil {
			c.log.Error("dead-letter produce failed; offset left uncommitted for redelivery", "error", derr)
			return
		}
		c.log.Warn("dlq: poison message dead-lettered", "topic", events.TopicNotificationDLQ, "bytes", len(m.Value))
	default:
		// Transient error (e.g. DB): do not commit; the message will redeliver.
		c.log.Error("handle message failed", "error", err)
		return
	}

	if err := c.reader.CommitMessages(ctx, m); err != nil {
		c.log.Error("commit message failed", "error", err)
	}
}

// deadLetter produces the original raw message bytes to the dead-letter topic,
// preserving the source key so partitioning is stable.
func (c *Consumer) deadLetter(ctx context.Context, m kafka.Message) error {
	return c.dlq.WriteMessages(ctx, kafka.Message{
		Key:   m.Key,
		Value: m.Value,
	})
}

func (c *Consumer) handle(ctx context.Context, value []byte) error {
	var ev events.TaskEvent
	if err := json.Unmarshal(value, &ev); err != nil {
		// Malformed payload: signal the caller to dead-letter (then commit) so a
		// poison pill cannot block the partition.
		c.log.Warn("unparseable task event", "error", err)
		return errMalformed
	}

	var kind, text string
	switch ev.Type {
	case events.TypeTaskAcknowledged:
		kind = events.KindTaskAcknowledged
		text = "Task acknowledged by " + ev.AssigneeUsername
	case events.TypeTaskCompleted:
		kind = events.KindTaskCompleted
		text = "Task completed by " + ev.AssigneeUsername
	case events.TypeTaskIgnored:
		kind = events.KindTaskIgnored
		text = "Task ignored by " + ev.AssigneeUsername
	case events.TypeTaskLeft:
		kind = events.KindTaskLeft
		text = "Task left by " + ev.AssigneeUsername
	default:
		return nil // ignore other event types
	}

	eventID, err := uuid.Parse(ev.EventID)
	if err != nil {
		c.log.Warn("skipping event with invalid eventId", "eventId", ev.EventID)
		return nil
	}

	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Dedup: claim this event id. If it already exists, skip.
	tag, err := tx.Exec(ctx,
		`INSERT INTO consumed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		eventID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		c.log.Info("duplicate event skipped", "eventId", ev.EventID)
		return nil
	}

	recipientID := ev.SenderID
	notifID, err := uuid.NewV7()
	if err != nil {
		return err
	}

	var taskID *string
	if ev.TaskID != "" {
		t := ev.TaskID
		taskID = &t
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text, task_id)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		notifID, ev.OrgID, recipientID, kind, text, taskID)
	if err != nil {
		return err
	}

	outID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	nc := events.NotificationCreated{
		Type:           events.TypeNotificationCreated,
		EventID:        outID.String(),
		OrgID:          ev.OrgID,
		OccurredAt:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		NotificationID: notifID.String(),
		RecipientID:    recipientID,
		Kind:           kind,
		Text:           text,
		TaskID:         taskID,
	}
	payload, err := json.Marshal(nc)
	if err != nil {
		return err
	}
	if err := outbox.Enqueue(ctx, tx, outID, events.TopicNotification, recipientID, payload); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		if errors.Is(err, pgx.ErrTxClosed) {
			return nil
		}
		return err
	}
	c.log.Info("notification created from task event",
		"type", ev.Type, "notificationId", notifID.String(), "recipientId", recipientID)
	return nil
}
