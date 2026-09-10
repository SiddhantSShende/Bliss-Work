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
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/internal/tracing"
	"github.com/task-board/shared-kafkaauth"
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
//
// FetchMessage + an explicit CommitMessages after a SUCCESSFUL handle, not
// ReadMessage: ReadMessage commits the offset itself before returning
// whenever the reader belongs to a consumer group (see kafka-go's own doc
// comment on it), which means a transient Postgres error or a panic partway
// through handling one message would already have advanced past it — the
// event is gone, with no error and no way to ever retry it. Withholding the
// commit on failure means a restart redelivers this message instead.
//
// (Kafka tracks one offset per partition, so a LATER message's successful
// commit still implicitly advances past an earlier failed one that was never
// individually committed — this closes "committed before the handler ever
// ran," not every possible interaction with a stuck partition. handle()'s
// dedup insert is what makes redelivering an already-applied message safe.)
func (c *AuthConsumer) Run(ctx context.Context) {
	defer c.r.Close()
	for {
		m, err := c.r.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			c.log.Error("auth consumer read failed", "err", err)
			// Same 1s backoff every other consumer in this codebase uses on a
			// FetchMessage error (see ws-gateway/internal/fanout/fanout.go's
			// Consumer.Run) — without it, a Kafka outage turns this into a
			// tight busy-loop that also floods the logs for its duration.
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			continue
		}
		msgCtx, span := startConsumeSpan(ctx, m)
		ok := c.handleSafely(msgCtx, m.Value)
		span.End()
		if !ok {
			continue
		}
		if err := c.r.CommitMessages(ctx, m); err != nil {
			c.log.Error("auth consumer commit failed", "err", err)
		}
	}
}

// handleSafely recovers a panic in handle so one malformed or unexpected
// message cannot crash the whole consumer process — a crash-loop would also
// redeliver every OTHER partition's in-flight, not-yet-committed message on
// restart, a much bigger blast radius than logging this one and moving on.
// Reports false (do not commit) on a recovered panic, same as any other
// transient failure.
func (c *AuthConsumer) handleSafely(ctx context.Context, value []byte) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			c.log.Error("auth consumer handler panicked", "panic", r)
			ok = false
		}
	}()
	return c.handle(ctx, value)
}

// handle processes one message and reports whether its offset is safe to
// commit: true for a genuine success OR a message this consumer deliberately
// skips (malformed payload, an event type it does not handle — retrying
// either would never produce a different outcome); false only for a real
// failure, so Run leaves the offset uncommitted and a restart retries it.
func (c *AuthConsumer) handle(ctx context.Context, value []byte) bool {
	var head struct {
		Type    string `json:"type"`
		EventID string `json:"eventId"`
	}
	if err := json.Unmarshal(value, &head); err != nil {
		c.log.Error("auth consumer bad json", "err", err)
		return true
	}
	// Org deletion is handled before the dedup claim below, deliberately: the
	// purge empties consumed_events for this org, so a claim would delete
	// itself and a redelivery would look new. PurgeOrg is idempotent instead,
	// which is the property that actually matters.
	if head.Type == events.TypeOrgDeleted {
		return c.purgeOrg(ctx, value)
	}

	switch head.Type {
	case events.TypeUserCreated, events.TypeUserDeactivated,
		events.TypeUserReactivated, events.TypeUserRemoved:
	default:
		return true
	}

	// Cheap pre-check, not a claim: skip straight past an already-applied
	// redelivery without redoing its write. The actual claim happens only
	// after that write succeeds, below — claiming here instead would make a
	// genuine write failure indistinguishable from success the moment this
	// event is redelivered, since the check would then report "already done"
	// and skip the retry this fix exists to enable.
	done, err := c.store.IsConsumed(ctx, head.EventID)
	if err != nil {
		c.log.Error("dedup check failed", "eventId", head.EventID, "err", err)
		return false
	}
	if done {
		return true
	}

	if head.Type != events.TypeUserCreated {
		// Membership lifecycle. The row stays — a departed member's name still
		// has to render on everything they left behind — only `active` moves.
		var evt events.MembershipChanged
		if err := json.Unmarshal(value, &evt); err != nil {
			c.log.Error("auth consumer decode membership change", "type", head.Type, "err", err)
			return true
		}
		active := head.Type == events.TypeUserReactivated
		if err := c.store.SetUserActive(ctx, evt.UserID, active); err != nil {
			c.log.Error("user_projection set active failed", "userId", evt.UserID, "err", err)
			return false
		}
		if _, err := c.store.MarkConsumed(ctx, head.EventID); err != nil {
			c.log.Error("dedup insert failed", "eventId", head.EventID, "err", err)
			return false
		}
		c.log.Info("user_projection membership changed", "userId", evt.UserID, "active", active)
		return true
	}

	var evt events.UserCreated
	if err := json.Unmarshal(value, &evt); err != nil {
		c.log.Error("auth consumer decode user.created", "err", err)
		return true
	}
	if err := c.store.UpsertUser(ctx, evt.UserID, evt.OrgID, evt.Username, evt.DisplayName, evt.Email); err != nil {
		c.log.Error("upsert user_projection failed", "userId", evt.UserID, "err", err)
		return false
	}
	if _, err := c.store.MarkConsumed(ctx, head.EventID); err != nil {
		c.log.Error("dedup insert failed", "eventId", head.EventID, "err", err)
		return false
	}
	c.log.Info("user_projection upserted", "userId", evt.UserID, "username", evt.Username)
	return true
}

// purgeOrg erases one organization: its rows, then its attachment bytes.
//
// Rows first. If the process dies between the two the blobs are orphaned but
// unreachable — no row references them and the crypto-shred already made every
// encrypted column unreadable — and the next redelivery finishes the job. The
// other order would leave rows pointing at files that are already gone, which
// renders as broken attachments rather than as an absent workspace.
//
// PurgeOrg's row deletes and RemoveOrg's blob sweep are both safe to repeat —
// deleting or unlinking something already gone is a no-op — so returning
// false on either failure and letting Run withhold the commit is what
// actually makes "the next redelivery finishes the job" true, rather than
// aspirational: before FetchMessage/CommitMessages replaced the old
// auto-committing ReadMessage, the offset was already gone by the time this
// function even started.
func (c *AuthConsumer) purgeOrg(ctx context.Context, value []byte) bool {
	var evt struct {
		OrgID string `json:"orgId"`
	}
	if err := json.Unmarshal(value, &evt); err != nil || evt.OrgID == "" {
		c.log.Error("auth consumer decode org.deleted", "err", err)
		return true
	}

	deleted, err := c.store.PurgeOrg(ctx, evt.OrgID)
	if err != nil {
		c.log.Error("org purge failed", "orgId", evt.OrgID, "err", err)
		return false
	}
	if err := c.blobs.RemoveOrg(evt.OrgID); err != nil {
		c.log.Error("org blob purge failed", "orgId", evt.OrgID, "err", err)
		return false
	}
	c.log.Warn("org purged", "orgId", evt.OrgID, "rows", deleted)
	return true
}
