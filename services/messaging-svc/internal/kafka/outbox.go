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

	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/internal/tracing"
)

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
		Addr:                   kafka.TCP(brokers...),
		Balancer:               &kafka.Hash{}, // key-based partitioning
		AllowAutoTopicCreation: false,
		RequiredAcks:           kafka.RequireAll,
		BatchTimeout:           50 * time.Millisecond,
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
	rows, err := p.store.FetchUnpublished(ctx, 100)
	if err != nil {
		p.log.Error("outbox fetch failed", "err", err)
		return
	}
	tracer := otel.Tracer("kafka")
	for _, r := range rows {
		msg := kafka.Message{
			Topic: r.Topic,
			Key:   []byte(r.Key),
			Value: r.Payload,
		}
		// PRODUCER span per message; inject W3C trace context into the message
		// headers so the consumer can continue this trace. With tracing disabled
		// the global tracer is a no-op and the propagator injects nothing.
		spanCtx, span := tracer.Start(ctx, r.Topic+" send",
			trace.WithSpanKind(trace.SpanKindProducer),
			trace.WithAttributes(
				semconv.MessagingSystemKafka,
				semconv.MessagingDestinationName(r.Topic),
				semconv.MessagingOperationName("publish"),
			),
		)
		otel.GetTextMapPropagator().Inject(spanCtx, tracing.NewKafkaHeaderCarrier(&msg.Headers))
		span.End()
		if err := p.writer.WriteMessages(ctx, msg); err != nil {
			p.log.Error("outbox publish failed", "topic", r.Topic, "id", r.ID, "err", err)
			return // retry remaining rows next tick (preserve order)
		}
		if err := p.store.MarkPublished(ctx, r.ID); err != nil {
			p.log.Error("outbox mark published failed", "id", r.ID, "err", err)
			return
		}
	}
}
