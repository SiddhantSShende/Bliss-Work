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

	"github.com/task-board/shared-backoff"
	"github.com/task-board/shared-kafkaauth"
	"github.com/task-board/ws-gateway/internal/contract"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/metrics"
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

// outboxWriteMaxAttempts is the total number of AppendOutbox attempts (1
// initial + 2 retries) per recipient. A write failure here was previously
// silent: the loop still proceeded to Fanout and the Kafka offset still
// committed regardless, so a recipient who was offline (or shed) at that same
// moment permanently lost this event's replay entry — a real hole in the
// at-least-once guarantee the rest of this file documents.
const outboxWriteMaxAttempts = 3

// outboxWriteRetryPolicy mirrors internal/delivery's short, capped-exponential
// policy (same shared/backoff idiom), but even shorter: this runs inside the
// per-event handle loop, ahead of live delivery to every recipient of this
// event, so the backoff must stay short enough that a Redis blip can't
// visibly stall fanout for everyone else on the same event.
var outboxWriteRetryPolicy = backoff.Policy{Base: 20 * time.Millisecond, Max: 200 * time.Millisecond}

// New creates a Consumer.
//
// groupID must be unique per NODE (so this instance receives all partitions
// rather than sharing them with its peers) and STABLE across restarts of that
// node. Both halves matter and only the first used to hold: the id was
// "ws-gateway-"+nodeID with nodeID a UUID minted at process start, so every
// restart joined Kafka as a group that had never committed an offset and
// therefore began at StartOffset — the tip.
//
// In this mode the gateway is the only writer of the replay outbox, so events
// published while the pod was down were not just missed live, they were never
// written to anybody's catch-up buffer and no reconnect could recover them. A
// rolling deploy was a guaranteed silent hole in delivery. With a stable id the
// pod resumes from its committed offset and re-reads the gap.
//
// See config.BroadcastGroupID for how the identity is chosen and what it still
// cannot cover (a Deployment rollout mints new pod names).
func New(brokers []string, groupID string, st *store.Store, h *hub.Hub, log *slog.Logger) *Consumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     brokers,
		GroupID:     groupID,
		GroupTopics: contract.FanoutTopics,
		MinBytes:    1,
		MaxBytes:    10e6,
		MaxWait:     250 * time.Millisecond,
		// Applies ONLY to a group with no committed offset — i.e. the very first
		// start of a given group id. After that the committed offset takes over,
		// which is exactly what the stable id above makes reachable.
		StartOffset:    kafka.LastOffset,
		CommitInterval: time.Second,
		// nil unless KAFKA_SECURITY_PROTOCOL asks for TLS/SASL, which is
		// exactly what ReaderConfig wants for an unauthenticated broker.
		Dialer: kafkaauth.Dialer(),
	})
	return &Consumer{reader: reader, store: st, hub: h, log: log}
}

// Run consumes until ctx is cancelled.
//
// ── FetchMessage + CommitMessages, not ReadMessage ───────────────────────────
// kafka-go's ReadMessage is FetchMessage followed by CommitMessages, so the
// offset is queued for commit as part of the READ — before handle() has written
// anything to the replay outbox. With CommitInterval set, that commit can land
// while the event is still being processed, and a crash in that window skips it
// permanently: the outbox write never happened, and the offset says it did.
//
// Fetching and committing explicitly moves the commit after the work, which is
// the at-least-once posture this pipeline is designed around — every consumer
// dedupes on eventId and the outbox write is an idempotent ZADD, so a duplicate
// costs nothing and a gap costs a message.
func (c *Consumer) Run(ctx context.Context) {
	defer func() { _ = c.reader.Close() }()
	c.log.Info("kafka fan-out consumer started", "topics", contract.FanoutTopics)
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

		// Only now is the event durable in the recipients' replay outboxes, so
		// only now may the offset move. A commit failure is logged and NOT
		// retried here: the next successful commit carries this offset with it,
		// and blocking the loop on it would stall live delivery for a
		// bookkeeping error whose worst case is re-reading an event the clients
		// already dedupe.
		if err := c.reader.CommitMessages(ctx, msg); err != nil && ctx.Err() == nil {
			c.log.Warn("kafka commit failed; event will be re-read",
				"topic", msg.Topic, "partition", msg.Partition, "offset", msg.Offset, "err", err)
		}
	}
}

func (c *Consumer) handle(ctx context.Context, raw []byte) {
	// Counted before parsing: an event this node could not read is still an
	// event this node was made to receive, which is the cost being measured.
	metrics.FanoutEventsConsumed.Inc()

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

	score := contract.EpochMs(ev.OccurredAt)
	metrics.FanoutRecipientsTotal.Add(float64(len(recipients)))

	// Recipients are resolved; the routing metadata has done its job. Strip it
	// BEFORE the loop, because everything below happens once per recipient and
	// this is precisely the multiplication that made channel fan-out quadratic
	// in roster size. See contract.DeliveryPayload.
	payload := contract.DeliveryPayload(raw)
	// The outbox may store a smaller reference instead (message.created only —
	// see contract.TryCompact); LIVE delivery below always uses the full
	// `payload`, never the outbox copy, since a socket has no reconstruction
	// step.
	outboxPayload := contract.TryCompact(&ev, payload)

	for _, uid := range recipients {
		var err error
		for attempt := 1; attempt <= outboxWriteMaxAttempts; attempt++ {
			if err = c.store.AppendOutbox(ctx, uid, score, outboxPayload); err == nil {
				break
			}
			if attempt == outboxWriteMaxAttempts || !outboxWriteRetryPolicy.Sleep(ctx.Done(), attempt) {
				break
			}
		}
		metrics.FanoutOutboxWritesTotal.WithLabelValues(metrics.Result(err)).Inc()
		if err != nil {
			c.log.Error("append outbox failed after retries",
				"user", uid, "attempts", outboxWriteMaxAttempts, "err", err)
		}
		// `live` records whether a socket for this recipient existed on this node
		// at delivery time — the decisive signal when diagnosing "messages need a
		// refresh" (live=false for an online user ⇒ socket churn, not a fan-out gap).
		//
		// It is also the amplification measurement. Every pod computes every
		// recipient of every event, so `live=false` here is work done for a user
		// this pod does not serve — and with N pods that is most of it.
		live := c.hub.Fanout(uid, payload)
		if live {
			metrics.FanoutDeliveredTotal.Inc()
		} else {
			metrics.FanoutDiscardedTotal.Inc()
		}
		c.log.Debug("fanout: delivered", "type", ev.Type, "user", uid, "live", live)
	}
}
