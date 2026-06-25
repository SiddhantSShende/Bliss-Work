package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/internal/tracing"
)

// startConsumeSpan extracts W3C trace context from a Kafka message's headers and
// starts a CONSUMER-kind span "<topic> process" as a child of that context. With
// tracing disabled the extracted context is empty and the span is a no-op. The
// caller must End() the returned span (e.g. via defer).
func startConsumeSpan(ctx context.Context, m kafka.Message) (context.Context, trace.Span) {
	hdrs := m.Headers
	msgCtx := otel.GetTextMapPropagator().Extract(ctx, tracing.NewKafkaHeaderCarrier(&hdrs))
	return otel.Tracer("kafka").Start(msgCtx, m.Topic+" process",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			semconv.MessagingSystemKafka,
			semconv.MessagingDestinationName(m.Topic),
			semconv.MessagingOperationName("process"),
		),
	)
}

// AuthConsumer consumes auth.events and maintains the user_projection.
type AuthConsumer struct {
	store *store.Store
	log   *slog.Logger
	r     *kafka.Reader
}

// NewAuthConsumer builds a reader bound to the "messaging-svc" consumer group.
func NewAuthConsumer(st *store.Store, brokers []string, log *slog.Logger) *AuthConsumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "messaging-svc",
		Topic:          events.TopicAuth,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: time.Second,
	})
	return &AuthConsumer{store: st, log: log, r: r}
}

// Run consumes until ctx is cancelled.
func (c *AuthConsumer) Run(ctx context.Context) {
	defer c.r.Close()
	for {
		m, err := c.r.ReadMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			c.log.Error("auth consumer read failed", "err", err)
			continue
		}
		msgCtx, span := startConsumeSpan(ctx, m)
		c.handle(msgCtx, m.Value)
		span.End()
	}
}

func (c *AuthConsumer) handle(ctx context.Context, value []byte) {
	var head struct {
		Type    string `json:"type"`
		EventID string `json:"eventId"`
	}
	if err := json.Unmarshal(value, &head); err != nil {
		c.log.Error("auth consumer bad json", "err", err)
		return
	}
	if head.Type != events.TypeUserCreated {
		return
	}

	// Dedup before applying side effects.
	fresh, err := c.store.MarkConsumed(ctx, head.EventID)
	if err != nil {
		c.log.Error("dedup insert failed", "eventId", head.EventID, "err", err)
		return
	}
	if !fresh {
		return // already processed
	}

	var evt events.UserCreated
	if err := json.Unmarshal(value, &evt); err != nil {
		c.log.Error("auth consumer decode user.created", "err", err)
		return
	}
	if err := c.store.UpsertUser(ctx, evt.UserID, evt.OrgID, evt.Username, evt.DisplayName); err != nil {
		c.log.Error("upsert user_projection failed", "userId", evt.UserID, "err", err)
		return
	}
	c.log.Info("user_projection upserted", "userId", evt.UserID, "username", evt.Username)
}
