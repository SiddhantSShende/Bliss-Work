// Package kafka contains the outbox publisher and the auth.events consumer.
package kafka

import (
	"context"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/messaging-svc/internal/metrics"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/internal/tracing"
	"github.com/task-board/shared-kafkaauth"
)

// outboxBatchSize is how many rows one drain claims and produces together.
//
// The whole batch goes to Kafka in a single WriteMessages call, so this is
// bounded by how long it is reasonable to hold the row locks — one broker round
// trip — rather than by the per-message cost it used to be bounded by.
const outboxBatchSize = 500

// maxPublishBytes is the largest single event this producer will attempt.
//
// ── Why it is stated rather than inherited ───────────────────────────────────
// kafka-go's Writer.BatchBytes defaults to 1048576 and is checked PER MESSAGE
// before anything is sent: one message over the limit makes WriteMessages
// return MessageTooLargeError and send NOTHING, so an oversized row also takes
// down the 499 healthy rows batched with it. kafka-go's own comment says the
// caller is expected to discard the offending message and retry; nothing did,
// so the poller re-claimed the same head-of-queue row every 500 ms forever and
// every event in the platform stopped behind it.
//
// Naming the number here does two things the default could not. It is now the
// SAME number the store checks against before offering a row (DrainOptions.
// MaxPayloadBytes), so an unpublishable row is quarantined deterministically
// instead of being discovered through a failed round trip. And it is explicit,
// so raising the broker's message.max.bytes is a two-line change rather than a
// silent mismatch between what we accept and what the broker takes.
//
// Kept at the Kafka default deliberately: the fix for large content is the
// attachment path, not a bigger event. MaxMessageBodyBytes (8 KiB) means a
// legitimate event is three orders of magnitude below this, so anything that
// trips it is a bug or an abuse, and quarantining it is the correct answer.
const maxPublishBytes = 1 << 20

// maxPublishAttempts quarantines a row that keeps failing for a reason that is
// NOT its size — an absent topic, a broker rejecting it for its own reasons.
// Sized to ride out a genuine outage: at one drain every 500 ms this is about
// five minutes of continuous failure before anything is set aside, which is far
// longer than a broker restart or a leader election.
const maxPublishAttempts = 600

// OutboxPoller publishes unpublished outbox rows to Kafka every ~500ms.
type OutboxPoller struct {
	store   *store.Store
	writer  *kafka.Writer
	log     *slog.Logger
	brokers []string
}

// NewOutboxPoller builds a poller with a single shared writer (topic per message).
func NewOutboxPoller(st *store.Store, brokers []string, log *slog.Logger) *OutboxPoller {
	w := &kafka.Writer{
		Addr: kafka.TCP(brokers...),
		// nil for a plaintext broker; kafka-go then uses its own default.
		Transport:              kafkaauth.Transport(),
		Balancer:               &kafka.Hash{}, // key-based partitioning
		AllowAutoTopicCreation: false,
		RequiredAcks:           kafka.RequireAll,
		// BatchTimeout is how long the writer waits for a batch to fill before
		// flushing it anyway. It only ever cost us latency when drain produced
		// one message at a time and every message waited out the full window;
		// now that a drain hands over the whole batch at once, this is just the
		// tail latency on a partial final batch. 10ms keeps that small.
		BatchTimeout: 10 * time.Millisecond,
		// Let one drain flush in as few round trips as possible rather than
		// being split into the default 100-message batches.
		BatchSize: outboxBatchSize,
		// Stated, not inherited — see maxPublishBytes. The store checks the
		// same number before a row is ever offered, so the two cannot drift.
		BatchBytes: maxPublishBytes,
	}
	return &OutboxPoller{store: st, writer: w, log: log, brokers: brokers}
}

// Run loops until ctx is cancelled, draining the outbox each tick.
func (p *OutboxPoller) Run(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	defer p.writer.Close()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.drain(ctx)
		}
	}
}

func (p *OutboxPoller) drain(ctx context.Context) {
	tracer := otel.Tracer("kafka")
	// The store owns the transaction so the claim can hold its row locks across
	// the produce; this callback is "put the whole batch on the wire", in ONE
	// WriteMessages call. A per-row callback would mean a per-row write, and a
	// single-message write waits out BatchTimeout before it flushes — which is
	// what used to cap this poller at roughly one message per batch window.
	stats, err := p.store.DrainUnpublished(ctx, outboxBatchSize, store.DrainOptions{
		MaxPayloadBytes: maxPublishBytes,
		MaxAttempts:     maxPublishAttempts,
	}, func(rows []store.OutboxRow) error {
		msgs := buildMessages(ctx, tracer, rows)
		// Per-key ordering survives: the Hash balancer routes by key, and
		// kafka-go preserves order within a batch per partition.
		if err := p.writer.WriteMessages(ctx, msgs...); err != nil {
			p.log.Error("outbox publish failed", "count", len(msgs), "err", err)
			return err
		}
		return nil
	})

	metrics.OutboxPublishedTotal.Add(float64(stats.Published))
	if stats.DeadLettered > 0 {
		metrics.OutboxDeadLetteredTotal.Add(float64(stats.DeadLettered))
		// ERROR, not warn. A quarantined row is an event a user's action
		// produced that no consumer will ever see — a message that will not be
		// delivered, a notification that will not fire. It is silent to the
		// user and invisible in the request logs, so this line and the metric
		// beside it are the only evidence it happened.
		p.log.Error("outbox rows dead-lettered; events accepted but never published",
			"count", stats.DeadLettered,
			"detail", "inspect: SELECT id, topic, publish_attempts, publish_error FROM outbox WHERE dead_lettered_at IS NOT NULL")
	}
	if err != nil {
		p.log.Error("outbox drain failed", "err", err)
	}
}

// buildMessages turns claimed outbox rows into Kafka messages, one for one and
// in order, stamping each with a PRODUCER span's trace context.
//
// Split out from drain so it can be tested without a database or a broker. The
// bug it exists to catch is silent: injecting the trace headers into a loop
// COPY rather than into the slice element leaves the sent message with no
// headers at all, which loses the producer→consumer trace link and shows up
// only as gaps in a tracing UI nobody is looking at during a refactor.
func buildMessages(ctx context.Context, tracer trace.Tracer, rows []store.OutboxRow) []kafka.Message {
	msgs := make([]kafka.Message, len(rows))
	for i, r := range rows {
		msgs[i] = kafka.Message{
			Topic: r.Topic,
			Key:   []byte(r.Key),
			Value: r.Payload,
		}
		// Inject W3C trace context into the message headers so the consumer can
		// continue this trace. With tracing disabled the global tracer is a
		// no-op and the propagator injects nothing.
		spanCtx, span := tracer.Start(ctx, r.Topic+" send",
			trace.WithSpanKind(trace.SpanKindProducer),
			trace.WithAttributes(
				semconv.MessagingSystemKafka,
				semconv.MessagingDestinationName(r.Topic),
				semconv.MessagingOperationName("publish"),
			),
		)
		otel.GetTextMapPropagator().Inject(spanCtx, tracing.NewKafkaHeaderCarrier(&msgs[i].Headers))
		span.End()
	}
	return msgs
}
