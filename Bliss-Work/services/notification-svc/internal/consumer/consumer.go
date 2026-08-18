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
	"github.com/task-board/notification-svc/internal/kafkaauth"
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

// New constructs a Consumer subscribed to task.events.v1, auth.events and
// messaging.events.v1 under group "notification-svc".
//
// Each secondary topic is read for exactly one message type:
//   - auth.events → org.deleted. Notifications carry task titles and message
//     previews, so an erased workspace has to take them with it.
//   - messaging.events.v1 → channel.member.joined. Being added to a channel by
//     someone else is a notification, and messaging-svc is the only service
//     that knows it happened.
//
// GroupTopics rather than one reader each — a single consumer group covering
// all three keeps offset management and rebalancing in one place.
func New(pool *pgxpool.Pool, brokers []string, log *slog.Logger) *Consumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "notification-svc",
		GroupTopics:    []string{events.TopicTask, events.TopicAuth, events.TopicMessaging},
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: 0, // commit synchronously after successful handling
		MaxWait:        500 * time.Millisecond,
		// Applies ONLY to a partition this group has never committed an offset
		// for, which in practice means a newly-subscribed topic. The default is
		// FirstOffset, and that default is wrong for a notification service:
		// adding messaging.events.v1 to an existing group would have replayed
		// the whole retained topic and told users they were added to channels
		// days ago, as news. A notification is about what is happening now.
		//
		// It costs nothing on the topics already subscribed — their committed
		// offsets win — and a genuine redelivery there is still caught by the
		// durable consumed_events dedup rather than by this.
		StartOffset: kafka.LastOffset,
		// nil unless KAFKA_SECURITY_PROTOCOL asks for TLS/SASL, which is
		// exactly what ReaderConfig wants for an unauthenticated broker.
		Dialer: kafkaauth.Dialer(),
	})
	// Dead-letter producer for poison (unparseable) messages.
	dlq := &kafka.Writer{
		Addr: kafka.TCP(brokers...),
		// nil for a plaintext broker; kafka-go then uses its own default.
		Transport:    kafkaauth.Transport(),
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
		c.runBatch(ctx)
	}
}

// Batch sizing.
//
// ── Why this consumer batches at all ────────────────────────────────────────
// This loop used to be strictly one message at a time: FetchMessage, a DB
// transaction, then a SYNCHRONOUS offset commit (CommitInterval is 0, and
// deliberately so). That is roughly three network round trips per event with no
// pipelining whatsoever, which caps a replica at a few hundred events/sec — on
// the topic that fans out to every subscriber of every event, and is therefore
// the highest-volume stream in the platform by orders of magnitude.
//
// Worse, the cap could not be lifted by adding replicas: consumer-group
// parallelism is bounded by partition count, so the ceiling was
// partitions × few-hundred no matter how many pods were running.
//
// Batching amortizes both fixed costs. One transaction and one offset commit
// now cover up to maxBatchSize events, so the round trips scale with batches
// instead of with messages.
const (
	// maxBatchSize bounds one transaction's worth of work. Larger batches
	// amortize better but hold row locks and an open transaction for longer,
	// and a transient failure re-does the whole batch — so this is chosen to
	// keep a retry cheap rather than to maximize throughput.
	maxBatchSize = 200

	// batchLinger is how long the loop waits for a batch to FILL once it has at
	// least one message. It is a latency budget, not a throughput knob: an idle
	// consumer still processes a lone event within this much of it arriving.
	//
	// Notifications surface in a UI, so this stays small. 25ms is far below the
	// threshold at which a person perceives a notification as delayed, and it
	// is enough to collect a large batch under the bursty load that actually
	// matters — a task fan-out arrives as a burst, not as a trickle.
	batchLinger = 25 * time.Millisecond
)

// runBatch fetches a batch of messages and processes them in ONE transaction,
// with panic recovery.
//
// The delivery guarantees are unchanged from the per-message version, which is
// the point — batching is an efficiency change and must not become a
// correctness one:
//
//   - Offsets are committed only after the batch's transaction commits, so a
//     crash anywhere before that redelivers the whole batch. Every event is
//     dedup-claimed by event_id inside the same transaction, so redelivery is
//     idempotent — reprocessing writes nothing the second time.
//   - A transient error abandons the ENTIRE batch uncommitted rather than the
//     successful prefix. That is a deliberate trade: it re-does work, and the
//     dedup makes re-doing it free, whereas committing a prefix would need
//     per-message offset tracking to stay correct.
//   - A malformed message is dead-lettered and its offset still committed, so a
//     poison pill cannot block the partition — and one poison message no longer
//     costs the whole batch, because it is skipped rather than failed.
func (c *Consumer) runBatch(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			c.log.Error("consumer panic recovered; offsets left uncommitted for redelivery", "panic", rec)
		}
	}()

	batch := c.fetchBatch(ctx)
	if len(batch) == 0 {
		return
	}

	tx, err := c.pool.Begin(ctx)
	if err != nil {
		c.log.Error("begin batch tx failed; offsets left uncommitted", "error", err, "batch", len(batch))
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Poison messages are collected rather than dead-lettered inline: producing
	// to the DLQ before the transaction commits would announce a decision the
	// database might still roll back.
	var poison []kafka.Message

	for _, m := range batch {
		// CONSUMER span as a child of the producer's injected trace context.
		// With tracing disabled the extracted context is empty and the span is
		// a no-op. Per message, not per batch — a batch is an implementation
		// detail of this consumer and spans belong to the events.
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
		err := c.handle(msgCtx, tx, m.Value)
		span.End()

		switch {
		case err == nil:
			// Projected onto the batch tx; committed with everything else.
		case errors.Is(err, errMalformed):
			poison = append(poison, m)
		default:
			// Transient (e.g. the DB went away). Abandon the batch; it
			// redelivers whole and the dedup makes that a no-op.
			c.log.Error("handle message failed; abandoning batch for redelivery",
				"error", err, "batch", len(batch))
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		if !errors.Is(err, pgx.ErrTxClosed) {
			c.log.Error("commit batch tx failed; offsets left uncommitted", "error", err, "batch", len(batch))
			return
		}
	}

	// Durable now. Dead-letter the poison, and only then advance offsets — if
	// the DLQ produce fails the batch redelivers, which is the safe direction.
	for _, m := range poison {
		if derr := c.deadLetter(ctx, m); derr != nil {
			c.log.Error("dead-letter produce failed; offsets left uncommitted for redelivery", "error", derr)
			return
		}
		c.log.Warn("dlq: poison message dead-lettered",
			"topic", events.TopicNotificationDLQ, "bytes", len(m.Value))
	}

	// One commit for the whole batch. CommitMessages advances each partition to
	// the highest offset it sees, so passing the batch is correct even when it
	// spans partitions or topics.
	if err := c.reader.CommitMessages(ctx, batch...); err != nil {
		c.log.Error("commit messages failed", "error", err, "batch", len(batch))
	}
}

// fetchBatch blocks for the first message, then collects whatever else is
// already waiting, up to maxBatchSize or batchLinger — whichever comes first.
//
// The first fetch is deliberately unbounded: an idle consumer must park on the
// broker rather than spin. Only once there IS work does the linger apply, so
// the batching costs latency exclusively when there is something to batch with.
func (c *Consumer) fetchBatch(ctx context.Context) []kafka.Message {
	first, err := c.reader.FetchMessage(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		c.log.Error("fetch message failed", "error", err)
		time.Sleep(time.Second)
		return nil
	}

	batch := make([]kafka.Message, 0, maxBatchSize)
	batch = append(batch, first)

	linger, cancel := context.WithTimeout(ctx, batchLinger)
	defer cancel()
	for len(batch) < maxBatchSize {
		m, err := c.reader.FetchMessage(linger)
		if err != nil {
			// Deadline reached (the batch is as full as it is going to get) or
			// shutdown. Either way, process what we have — the messages already
			// in hand are not dropped.
			break
		}
		batch = append(batch, m)
	}
	return batch
}

// deadLetter produces the original raw message bytes to the dead-letter topic,
// preserving the source key so partitioning is stable.
func (c *Consumer) deadLetter(ctx context.Context, m kafka.Message) error {
	return c.dlq.WriteMessages(ctx, kafka.Message{
		Key:   m.Key,
		Value: m.Value,
	})
}

// handle projects ONE event onto the caller's transaction.
//
// It does not own the transaction and must not commit it: the caller batches
// many events into a single tx (see runBatch), which is what keeps the DB round
// trips proportional to batches rather than to messages.
func (c *Consumer) handle(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.TaskEvent
	if err := json.Unmarshal(value, &ev); err != nil {
		// Malformed payload: signal the caller to dead-letter (then commit) so a
		// poison pill cannot block the partition.
		c.log.Warn("unparseable task event", "error", err)
		return errMalformed
	}

	// The workspace is gone; its notifications go with it. Handled before the
	// task switch because it arrives on a different topic and shares none of
	// the task-event shape beyond the envelope.
	if ev.Type == events.TypeOrgDeleted {
		return c.purgeOrg(ctx, tx, ev.OrgID)
	}

	// Same reasoning: a different topic and a different shape, so it re-reads
	// the raw bytes rather than pretending to be a task event.
	if ev.Type == events.TypeChannelMemberJoined {
		return c.channelMemberJoined(ctx, tx, value)
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

	var taskID *string
	if ev.TaskID != "" {
		t := ev.TaskID
		taskID = &t
	}

	return c.create(ctx, tx, notification{
		sourceEventID: ev.EventID,
		sourceType:    ev.Type,
		orgID:         ev.OrgID,
		recipientID:   ev.SenderID,
		kind:          kind,
		text:          text,
		taskID:        taskID,
	})
}

// channelMemberJoined turns "somebody added you to a channel" into a
// notification. Emitted by messaging-svc on every join, so the two cases it has
// to tell apart are the whole job:
//
//   - Added BY SOMEONE ELSE — actorId != userId. The user has no other way of
//     finding out; a channel simply appears in their sidebar. This is the case
//     the notification exists for.
//   - SELF-join of an open channel — actorId == userId. They clicked Join.
//     Telling them about it is noise.
//
// An absent actorId means a producer older than the field. Treated as "unknown,
// so stay quiet", because the alternative is announcing to users that they were
// added to channels they joined themselves.
func (c *Consumer) channelMemberJoined(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.ChannelMemberJoined
	if err := json.Unmarshal(value, &ev); err != nil {
		c.log.Warn("unparseable channel.member.joined", "error", err)
		return errMalformed
	}
	if ev.UserID == "" || ev.ActorID == "" || ev.ActorID == ev.UserID {
		return nil
	}

	return c.create(ctx, tx, notification{
		sourceEventID: ev.EventID,
		sourceType:    ev.Type,
		orgID:         ev.OrgID,
		recipientID:   ev.UserID,
		kind:          events.KindChannelAdded,
		text:          channelAddedText(ev.ChannelName),
	})
}

// channelAddedText is what the user reads in the bell.
//
// The name is a snapshot taken by the producer, and is absent only from a
// producer that predates the field — worth a vaguer sentence, not worth
// dropping a notification the user is entitled to.
func channelAddedText(channelName string) string {
	if channelName == "" {
		return "You were added to a channel"
	}
	return "You were added to #" + channelName
}

// notification is one row to write plus the outbox event that announces it.
type notification struct {
	// sourceEventID is the id of the event that caused this, and is what the
	// dedup claims — NOT the notification's own id, which is minted here and is
	// therefore different on every redelivery.
	sourceEventID string
	sourceType    string
	orgID         string
	recipientID   string
	kind          string
	text          string
	taskID        *string
}

// create writes the notification row and its outbox event onto the caller's
// transaction, exactly once per source event.
//
// It does NOT commit: the caller batches many events into one tx (see
// runBatch), which is what keeps the round trips proportional to batches rather
// than to messages.
func (c *Consumer) create(ctx context.Context, tx pgx.Tx, n notification) error {
	eventID, err := uuid.Parse(n.sourceEventID)
	if err != nil {
		c.log.Warn("skipping event with invalid eventId", "eventId", n.sourceEventID)
		return nil
	}

	// Dedup: claim this event id. If it already exists, skip. Within a batch
	// this also catches a duplicate that arrived twice in the SAME tx, because
	// the insert is visible to its own transaction.
	tag, err := tx.Exec(ctx,
		`INSERT INTO consumed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		eventID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		c.log.Info("duplicate event skipped", "eventId", n.sourceEventID)
		return nil
	}

	notifID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text, task_id)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		notifID, n.orgID, n.recipientID, n.kind, n.text, n.taskID)
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
		OrgID:          n.orgID,
		OccurredAt:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		NotificationID: notifID.String(),
		RecipientID:    n.recipientID,
		Kind:           n.kind,
		Text:           n.text,
		TaskID:         n.taskID,
	}
	payload, err := json.Marshal(nc)
	if err != nil {
		return err
	}
	if err := outbox.Enqueue(ctx, tx, outID, events.TopicNotification, n.recipientID, payload); err != nil {
		return err
	}

	// No Commit here — the batch owns it.
	c.log.Info("notification created",
		"type", n.sourceType, "notificationId", notifID.String(), "recipientId", n.recipientID)
	return nil
}

// purgeOrg deletes every notification belonging to a deleted organization.
//
// Idempotent, and deliberately not dedup-guarded: re-running it over an org
// that is already gone deletes nothing, which is a cheaper guarantee than
// tracking whether we have seen the event before.
func (c *Consumer) purgeOrg(ctx context.Context, tx pgx.Tx, orgID string) error {
	if orgID == "" {
		c.log.Warn("org.deleted with no orgId")
		return nil
	}
	tag, err := tx.Exec(ctx, `DELETE FROM notifications WHERE org_id = $1`, orgID)
	if err != nil {
		return err
	}
	c.log.Warn("org purged", "orgId", orgID, "notifications", tag.RowsAffected())
	return nil
}
