package fanout

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/ws-gateway/internal/contract"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
	"github.com/task-board/ws-gateway/internal/tracing"
)

// Consumer subscribes to all fan-out topics, computes recipients, persists each
// event to the per-user replay outbox, and pushes to any locally-connected
// sockets.
type Consumer struct {
	reader *kafka.Reader
	store  *store.Store
	hub    *hub.Hub
	log    *slog.Logger
}

// New creates a Consumer. The group id is unique per node so this instance
// receives ALL partitions/messages on the subscribed topics.
func New(brokers []string, nodeID string, st *store.Store, h *hub.Hub, log *slog.Logger) *Consumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "ws-gateway-" + nodeID,
		GroupTopics:    contract.FanoutTopics,
		MinBytes:       1,
		MaxBytes:       10e6,
		MaxWait:        250 * time.Millisecond,
		StartOffset:    kafka.LastOffset,
		CommitInterval: time.Second,
	})
	return &Consumer{reader: reader, store: st, hub: h, log: log}
}

// Run consumes until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context) {
	defer func() { _ = c.reader.Close() }()
	c.log.Info("kafka fan-out consumer started", "topics", contract.FanoutTopics)
	for {
		msg, err := c.reader.ReadMessage(ctx)
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
		// CONSUMER span as a child of the producer's injected trace context. With
		// tracing disabled the extracted context is empty and the span is a no-op.
		hdrs := msg.Headers
		msgCtx := otel.GetTextMapPropagator().Extract(ctx, tracing.NewKafkaHeaderCarrier(&hdrs))
		msgCtx, span := otel.Tracer("kafka").Start(msgCtx, msg.Topic+" process",
			trace.WithSpanKind(trace.SpanKindConsumer),
			trace.WithAttributes(
				semconv.MessagingSystemKafka,
				semconv.MessagingDestinationName(msg.Topic),
				semconv.MessagingOperationName("process"),
			),
		)
		c.handle(msgCtx, msg.Value)
		span.End()
	}
}

func (c *Consumer) handle(ctx context.Context, raw []byte) {
	var ev contract.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		c.log.Warn("skip unparseable event", "err", err)
		return
	}
	recipients := ev.RecipientsOf()
	if len(recipients) == 0 {
		// Internal-only or unknown event type — never pushed to a socket.
		c.log.Debug("fanout: no recipients", "type", ev.Type)
		return
	}

	score := epochMs(ev.OccurredAt)
	for _, uid := range recipients {
		if err := c.store.AppendOutbox(ctx, uid, score, raw); err != nil {
			c.log.Error("append outbox failed", "user", uid, "err", err)
		}
		// `live` records whether a socket for this recipient existed on this node
		// at delivery time — the decisive signal when diagnosing "messages need a
		// refresh" (live=false for an online user ⇒ socket churn, not a fan-out gap).
		live := c.hub.HasUser(uid)
		c.hub.Fanout(uid, raw)
		c.log.Debug("fanout: delivered", "type", ev.Type, "user", uid, "live", live)
	}
}

// epochMs converts an ISO-8601 UTC timestamp to epoch milliseconds. On parse
// failure it falls back to the current time so the event still has a sane score.
func epochMs(occurredAt string) int64 {
	if occurredAt == "" {
		return time.Now().UTC().UnixMilli()
	}
	t, err := time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return time.Now().UTC().UnixMilli()
	}
	return t.UTC().UnixMilli()
}
