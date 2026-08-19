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

	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/kafkaauth"
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

// AuthConsumer consumes auth.events, maintains the user_projection, and erases
// an organization's data when it is deleted.
type AuthConsumer struct {
	store *store.Store
	// blobs is needed for org deletion and nothing else. Attachment BYTES live
	// on disk rather than in Postgres and are not application-encrypted, so
	// neither the database purge nor the crypto-shred reaches them.
	blobs blob.Store
	log   *slog.Logger
	r     *kafka.Reader
}

// NewAuthConsumer builds a reader bound to the "messaging-svc" consumer group.
func NewAuthConsumer(st *store.Store, blobs blob.Store, brokers []string, log *slog.Logger) *AuthConsumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "messaging-svc",
		Topic:          events.TopicAuth,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: time.Second,
		// nil unless KAFKA_SECURITY_PROTOCOL asks for TLS/SASL, which is
		// exactly what ReaderConfig wants for an unauthenticated broker.
		Dialer: kafkaauth.Dialer(),
	})
	return &AuthConsumer{store: st, blobs: blobs, log: log, r: r}
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
	// Org deletion is handled before the dedup claim below, deliberately: the
	// purge empties consumed_events for this org, so a claim would delete
	// itself and a redelivery would look new. PurgeOrg is idempotent instead,
	// which is the property that actually matters.
	if head.Type == events.TypeOrgDeleted {
		c.purgeOrg(ctx, value)
		return
	}

	switch head.Type {
	case events.TypeUserCreated, events.TypeUserDeactivated,
		events.TypeUserReactivated, events.TypeUserRemoved:
	default:
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

	if head.Type != events.TypeUserCreated {
		// Membership lifecycle. The row stays — a departed member's name still
		// has to render on everything they left behind — only `active` moves.
		var evt events.MembershipChanged
		if err := json.Unmarshal(value, &evt); err != nil {
			c.log.Error("auth consumer decode membership change", "type", head.Type, "err", err)
			return
		}
		active := head.Type == events.TypeUserReactivated
		if err := c.store.SetUserActive(ctx, evt.UserID, active); err != nil {
			c.log.Error("user_projection set active failed", "userId", evt.UserID, "err", err)
			return
		}
		c.log.Info("user_projection membership changed", "userId", evt.UserID, "active", active)
		return
	}

	var evt events.UserCreated
	if err := json.Unmarshal(value, &evt); err != nil {
		c.log.Error("auth consumer decode user.created", "err", err)
		return
	}
	if err := c.store.UpsertUser(ctx, evt.UserID, evt.OrgID, evt.Username, evt.DisplayName, evt.Email); err != nil {
		c.log.Error("upsert user_projection failed", "userId", evt.UserID, "err", err)
		return
	}
	c.log.Info("user_projection upserted", "userId", evt.UserID, "username", evt.Username)
}

// purgeOrg erases one organization: its rows, then its attachment bytes.
//
// Rows first. If the process dies between the two the blobs are orphaned but
// unreachable — no row references them and the crypto-shred already made every
// encrypted column unreadable — and the next redelivery finishes the job. The
// other order would leave rows pointing at files that are already gone, which
// renders as broken attachments rather than as an absent workspace.
func (c *AuthConsumer) purgeOrg(ctx context.Context, value []byte) {
	var evt struct {
		OrgID string `json:"orgId"`
	}
	if err := json.Unmarshal(value, &evt); err != nil || evt.OrgID == "" {
		c.log.Error("auth consumer decode org.deleted", "err", err)
		return
	}

	deleted, err := c.store.PurgeOrg(ctx, evt.OrgID)
	if err != nil {
		c.log.Error("org purge failed", "orgId", evt.OrgID, "err", err)
		return
	}
	if err := c.blobs.RemoveOrg(evt.OrgID); err != nil {
		// Loud, and NOT fatal to the rows we already removed. Leftover bytes on
		// a disk are a cleanup task; a half-purged database is a correctness
		// problem. The retry comes with the next redelivery.
		c.log.Error("org blob purge failed", "orgId", evt.OrgID, "err", err)
	}
	c.log.Warn("org purged", "orgId", evt.OrgID, "rows", deleted)
}
