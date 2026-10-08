package router

import (
	"context"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/shared-backoff"
	"github.com/task-board/shared-kafkaauth"
	"github.com/task-board/ws-gateway/internal/contract"
	"github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/tracing"
)

// ConsumerGroup is the shared group id for routed delivery.
//
// THE WHOLE POINT, in one string. The broadcast consumer uses
// "ws-gateway-<nodeId>" — a group per pod, so Kafka delivers every partition to
// every pod and each one receives the entire stream. This is a single stable
// group across every replica, so Kafka assigns each partition to exactly ONE
// consumer and the stream is read once no matter how many replicas run.
//
// Scale this service by adding replicas up to the partition count. Beyond that
// the extra replicas idle, which is the normal Kafka consumer-group property
// and the reason the topics are provisioned with room (TOPIC_PARTITIONS=12,
// NOTIFICATION_PARTITIONS=200 in production).
const ConsumerGroup = "delivery-svc"

// routeRetryPolicy paces re-attempts of an event whose routing failed on a
// transient dependency error. Capped so a Redis outage that lasts minutes is
// probed every few seconds rather than hammered, but short enough that recovery
// is noticed promptly; jittered (see shared/backoff) so every replica does not
// retry in lockstep against a recovering Redis. A var so tests can shrink it.
var routeRetryPolicy = backoff.Policy{Base: 100 * time.Millisecond, Max: 5 * time.Second}

// reader is the slice of *kafka.Reader the consumer loop uses, as an interface
// so the fetch/route/commit ordering can be tested without a broker.
type reader interface {
	FetchMessage(ctx context.Context) (kafka.Message, error)
	CommitMessages(ctx context.Context, msgs ...kafka.Message) error
	Close() error
}

// Consumer reads the fan-out topics and hands each event to a Router.
type Consumer struct {
	reader reader
	router *Router
	log    *slog.Logger
}

// NewConsumer builds the shared-group reader.
func NewConsumer(brokers []string, r *Router, log *slog.Logger) *Consumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     brokers,
		GroupID:     ConsumerGroup,
		GroupTopics: contract.FanoutTopics,
		MinBytes:    1,
		MaxBytes:    10e6,
		MaxWait:     250 * time.Millisecond,
		// StartOffset applies only to a group with no committed offset — the
		// very first start. LastOffset means a brand-new deployment does not
		// replay the topic's whole retention into everyone's outbox; after
		// that, committed offsets take over and a restart resumes where it
		// stopped. (The broadcast consumer makes the same choice for the same
		// reason, though for it the choice recurs on every pod start.)
		StartOffset:    kafka.LastOffset,
		CommitInterval: time.Second,
		Dialer:         kafkaauth.Dialer(),
	})
	return &Consumer{reader: reader, router: r, log: log}
}

// deliver routes one event, retrying transient failures until it succeeds or
// the consumer is shut down. It returns true when the event is processed (the
// caller may commit its offset) and false only when ctx was cancelled first (the
// caller must not).
//
// Blocking the partition here is deliberate: while Redis is failing no event on
// it can be written to an outbox or routed, so moving on would only turn each
// of them into a silent loss. Permanent failures never reach this loop — Route
// reports those as success after skipping and counting them.
func (c *Consumer) deliver(ctx, msgCtx context.Context, value []byte) bool {
	// Once per event, not per attempt, so retries do not inflate it.
	metrics.FanoutEventsConsumed.Inc()
	for attempt := 1; ; attempt++ {
		err := c.router.Route(msgCtx, value)
		if err == nil {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		metrics.RouteRetriesTotal.Inc()
		c.log.Error("routing failed; retrying without committing the offset",
			"attempt", attempt, "err", err)
		if !routeRetryPolicy.Sleep(ctx.Done(), attempt) {
			return false
		}
	}
}

// Run consumes until ctx is cancelled.
//
// ── FetchMessage + CommitMessages, not ReadMessage ───────────────────────────
// The comment here used to claim at-least-once and the code delivered the
// opposite for a ~1s window. kafka-go's ReadMessage is FetchMessage followed by
// CommitMessages, so the offset was queued for commit as part of the READ —
// before Route() had written anything to a replay outbox. With CommitInterval
// set, that commit could land while the event was still in flight, and a crash
// in that window skipped it permanently: the outbox write never happened and
// the offset said it did.
//
// Fetching and committing explicitly moves the commit after the work, which
// makes the stated posture true. A duplicate costs nothing — the outbox write
// is an idempotent ZADD of the same member and clients dedupe on eventId — and
// a gap costs a message.
func (c *Consumer) Run(ctx context.Context) {
	defer func() { _ = c.reader.Close() }()
	c.log.Info("routed delivery consumer started",
		"group", ConsumerGroup, "topics", contract.FanoutTopics)
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log.Error("kafka read failed", "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			continue
		}
		// CONSUMER span as a child of the producer's injected trace context, so
		// a delivery can be followed from the API call that caused it all the
		// way to the push. With tracing disabled this is a no-op.
		hdrs := msg.Headers
		msgCtx := otel.GetTextMapPropagator().Extract(ctx, tracing.NewKafkaHeaderCarrier(&hdrs))
		msgCtx, span := otel.Tracer("kafka").Start(msgCtx, msg.Topic+" route",
			trace.WithSpanKind(trace.SpanKindConsumer),
			trace.WithAttributes(
				semconv.MessagingSystemKafka,
				semconv.MessagingDestinationName(msg.Topic),
				semconv.MessagingOperationName("process"),
			),
		)
		done := c.deliver(ctx, msgCtx, msg.Value)
		span.End()
		if !done {
			// Shutting down mid-retry. The event is NOT processed, so its offset
			// must not move: the next start re-reads it from the committed one.
			return
		}

		// Only now is the event durable in the recipients' replay outboxes, so
		// only now may the offset move. A commit failure is logged and not
		// retried here: the next successful commit carries this offset with it,
		// and blocking the loop would stall delivery for a bookkeeping error
		// whose worst case is re-reading an event clients already dedupe.
		if err := c.reader.CommitMessages(ctx, msg); err != nil && ctx.Err() == nil {
			c.log.Warn("kafka commit failed; event will be re-read",
				"topic", msg.Topic, "partition", msg.Partition, "offset", msg.Offset, "err", err)
		}
	}
}
