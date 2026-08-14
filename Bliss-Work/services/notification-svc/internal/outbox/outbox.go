package outbox

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/task-board/notification-svc/internal/tracing"
)

// Row mirrors one unpublished outbox record.
type row struct {
	id      uuid.UUID
	topic   string
	key     string
	payload []byte
}

// Publisher polls the outbox table and produces unpublished rows to Kafka.
type Publisher struct {
	pool    *pgxpool.Pool
	brokers []string
	log     *slog.Logger
	writer  *kafka.Writer
}

// NewPublisher constructs a Publisher. The kafka.Writer routes per-message via
// the Topic field on each kafka.Message.
func NewPublisher(pool *pgxpool.Pool, brokers []string, log *slog.Logger) *Publisher {
	w := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		BatchTimeout: 50 * time.Millisecond,
	}
	return &Publisher{pool: pool, brokers: brokers, log: log, writer: w}
}

// Run loops every ~500ms publishing unpublished outbox rows until ctx is done.
// The tick body is wrapped so a panic logs at ERROR and the loop continues
// instead of silently killing the goroutine.
func (p *Publisher) Run(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	defer p.writer.Close()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.tick(ctx)
		}
	}
}

// tick runs one publish pass with panic recovery so a single bad batch cannot
// kill the publisher goroutine.
func (p *Publisher) tick(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			p.log.Error("outbox publisher panic recovered", "panic", rec)
		}
	}()
	if err := p.publishBatch(ctx); err != nil {
		p.log.Error("outbox publish batch failed", "error", err)
	}
}

func (p *Publisher) publishBatch(ctx context.Context) error {
	// One transaction spanning the claim, the produce and the mark.
	//
	// The claim needs FOR UPDATE SKIP LOCKED so a second replica takes a
	// DIFFERENT batch — otherwise every replica reads the same 100 rows and
	// produces all of them. Consumers dedup on eventId so nothing corrupts, but
	// Kafka volume and consumed_events writes multiply by replica count, and
	// this is the highest-fan-out topic in the product.
	//
	// The transaction is what makes the lock mean anything. This used to run on
	// p.pool directly, where each statement is its own implicit transaction and
	// the row locks would be released the moment the cursor closed — the clause
	// would have looked right and done nothing.
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	// Rollback is the correct outcome for every early return below: nothing has
	// been marked published, so the next tick retries. A no-op after Commit.
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT id, topic, kafka_key, payload
		   FROM outbox
		  WHERE published_at IS NULL
		  ORDER BY created_at
		  LIMIT 100
		  FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}

	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.topic, &r.key, &r.payload); err != nil {
			rows.Close()
			return err
		}
		batch = append(batch, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(batch) == 0 {
		return nil
	}

	tracer := otel.Tracer("kafka")
	msgs := make([]kafka.Message, len(batch))
	for i, r := range batch {
		msgs[i] = kafka.Message{
			Topic: r.topic,
			Key:   []byte(r.key),
			Value: r.payload,
		}
		// PRODUCER span per message; inject W3C trace context into the message
		// headers so the consumer can continue this trace. With tracing disabled
		// the global tracer is a no-op and the propagator injects nothing.
		spanCtx, span := tracer.Start(ctx, r.topic+" send",
			trace.WithSpanKind(trace.SpanKindProducer),
			trace.WithAttributes(
				semconv.MessagingSystemKafka,
				semconv.MessagingDestinationName(r.topic),
				semconv.MessagingOperationName("publish"),
			),
		)
		otel.GetTextMapPropagator().Inject(spanCtx, tracing.NewKafkaHeaderCarrier(&msgs[i].Headers))
		span.End()
	}
	// Produce to Kafka first. Only after a successful WriteMessages do we mark
	// rows published; if this fails we return without touching published_at so
	// the next tick retries (at-least-once delivery).
	if err := p.writer.WriteMessages(ctx, msgs...); err != nil {
		return err
	}

	ids := make([]uuid.UUID, len(batch))
	for i, r := range batch {
		ids[i] = r.id
	}
	// Post-publish bookkeeping. If this fails the rows have already been
	// produced, so the rollback leaves them unpublished and a later tick
	// re-produces them — a rare at-least-once dup, which is acceptable and is
	// what consumers' eventId dedup is for. Log and continue rather than crash.
	if _, err := tx.Exec(ctx,
		`UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, ids); err != nil {
		p.log.Error("outbox mark-published failed after produce (rows may be re-sent)", "error", err, "count", len(batch))
		return nil
	}
	// Commit also releases the row locks. Same at-least-once story if it fails.
	if err := tx.Commit(ctx); err != nil {
		p.log.Error("outbox commit failed after produce (rows may be re-sent)", "error", err, "count", len(batch))
		return nil
	}
	p.log.Info("published outbox rows", "count", len(batch))
	return nil
}

// Enqueue inserts an outbox row inside the provided transaction. The payload
// must already be the full, marshaled event JSON.
func Enqueue(ctx context.Context, tx pgx.Tx, id uuid.UUID, topic, key string, payload []byte) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO outbox (id, topic, kafka_key, payload) VALUES ($1, $2, $3, $4)`,
		id, topic, key, payload)
	return err
}
