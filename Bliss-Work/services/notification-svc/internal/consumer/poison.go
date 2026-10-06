package consumer

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/notification-svc/internal/tracing"
)

// errIsolate is returned by projectOnce when the shared batch transaction was
// aborted by a PERMANENT database error. The transaction is unusable at that
// point, so the batch is rolled back and re-projected one message at a time
// (projectBatch) to find and dead-letter the message that caused it.
var errIsolate = errors.New("permanent database error in batch; isolating")

// sanitizeText makes s storable in a Postgres text column AND in the jsonb
// outbox payload. Both reject U+0000 (SQLSTATE 22021 for text, 22P05 for a
// jsonb "\u0000" escape), and text also rejects invalid UTF-8. messaging-svc
// accepts a NUL in a message body (it is encrypted, so the column never
// objects), so any text built from an event field has to be cleaned here: the
// alternative is a permanent insert failure on the same offset forever.
func sanitizeText(s string) string {
	if strings.IndexByte(s, 0) >= 0 {
		s = strings.ReplaceAll(s, "\x00", "")
	}
	return strings.ToValidUTF8(s, "�")
}

// isPermanentDBError reports a database error that re-running the same event
// can never cure, because it is about the event's own data: class 22 (data
// exception, e.g. 22021 invalid byte sequence / NUL, 22P02 bad uuid, 22001
// value too long) and the constraint violations 23502 (not null), 23503
// (foreign key) and 23514 (check). Everything else — connection loss, 40001/
// 40P01 conflicts, 53xxx resources, 57xxx shutdown, and 23505 (a unique
// violation can be a concurrent-writer race) — stays transient.
func isPermanentDBError(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	if strings.HasPrefix(pgErr.Code, "22") {
		return true
	}
	switch pgErr.Code {
	case "23502", "23503", "23514":
		return true
	}
	return false
}

// projectBatch projects every message of batch in one transaction and commits
// it, returning the messages that must be dead-lettered. A non-nil error means
// the batch was abandoned (and already logged): the caller must stop the
// process so it redelivers.
//
// The fast path is one transaction for the whole batch. A permanent database
// error inside it aborts the transaction, which would otherwise be reported as
// transient: runBatch would stop, the restarted process would refetch the same
// batch, hit the same row and stop again — a poison event wedging its
// partition. So that case is retried once with each message under its own
// savepoint, which lets the offending message be dead-lettered while the rest
// of the batch commits.
func (c *Consumer) projectBatch(ctx context.Context, batch []kafka.Message) ([]kafka.Message, error) {
	poison, err := c.projectOnce(ctx, batch, false)
	if errors.Is(err, errIsolate) {
		c.log.Warn("permanent database error; reprocessing the batch one message at a time", "batch", len(batch))
		poison, err = c.projectOnce(ctx, batch, true)
	}
	return poison, err
}

func (c *Consumer) projectOnce(ctx context.Context, batch []kafka.Message, isolate bool) ([]kafka.Message, error) {
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		c.log.Error("begin batch tx failed; batch abandoned, restarting for redelivery", "error", err, "batch", len(batch))
		return nil, err
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
		var herr error
		if isolate {
			herr = c.handleIsolated(msgCtx, tx, m.Value)
		} else {
			herr = c.handle(msgCtx, tx, m.Value)
		}
		span.End()

		switch {
		case herr == nil:
			// Projected onto the batch tx; committed with everything else.
		case errors.Is(herr, errMalformed):
			poison = append(poison, m)
		case isPermanentDBError(herr):
			if !isolate {
				return nil, errIsolate
			}
			c.log.Error("permanent database error on one message; dead-lettering it",
				"error", herr, "topic", m.Topic, "partition", m.Partition, "offset", m.Offset)
			poison = append(poison, m)
		default:
			// Transient (e.g. the DB went away). Abandon the batch and
			// restart (see runBatch's doc comment) so it genuinely
			// redelivers; the dedup makes reprocessing a no-op.
			c.log.Error("handle message failed; batch abandoned, restarting for redelivery",
				"error", herr, "batch", len(batch))
			return nil, herr
		}
	}

	if err := tx.Commit(ctx); err != nil {
		if !errors.Is(err, pgx.ErrTxClosed) {
			c.log.Error("commit batch tx failed; batch abandoned, restarting for redelivery", "error", err, "batch", len(batch))
			return nil, err
		}
	}
	return poison, nil
}

// handleIsolated runs handle under a savepoint so a database error aborts only
// this message's writes, not the batch transaction. A malformed message keeps
// whatever it had already written, exactly as on the fast path, so isolating a
// batch never changes what a message does — only what a failing one costs.
func (c *Consumer) handleIsolated(ctx context.Context, tx pgx.Tx, value []byte) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	herr := c.handle(ctx, sp, value)
	if herr == nil || errors.Is(herr, errMalformed) {
		if err := sp.Commit(ctx); err != nil {
			return err
		}
		return herr
	}
	_ = sp.Rollback(ctx)
	return herr
}
