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
	"github.com/task-board/shared-kafkaauth"
)

// Row mirrors one unpublished outbox record.
type row struct {
	id      uuid.UUID
	topic   string
	key     string
	payload []byte
}

// maxPublishBytes is the largest single event this publisher will attempt.
//
// kafka-go's Writer.BatchBytes defaults to 1048576 and is checked PER MESSAGE
// before anything is sent: one oversized message makes WriteMessages return
// MessageTooLargeError and send NOTHING, so it also takes down the 99 healthy
// rows batched with it. kafka-go's own comment says the caller is expected to
// discard the offending message and retry; nothing did, so the publisher
// re-claimed the same head-of-queue row every 500 ms indefinitely and every
// notification in the platform queued behind it.
const maxPublishBytes = 1 << 20

// maxPublishAttempts quarantines a row that keeps failing for a reason that is
// NOT its size. At one tick every 500 ms this is about five minutes of
// continuous failure — far longer than a broker restart or a leader election,
// so a genuine outage drains normally once it clears.
const maxPublishAttempts = 600

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
		Addr: kafka.TCP(brokers...),
		// nil for a plaintext broker; kafka-go then uses its own default.
		Transport:    kafkaauth.Transport(),
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		BatchTimeout: 50 * time.Millisecond,
		// Stated, not inherited — see maxPublishBytes. publishBatch checks the
		// same number before a row is offered, so the two cannot drift.
		BatchBytes: maxPublishBytes,
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
		  WHERE published_at IS NULL AND dead_lettered_at IS NULL
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

	// Split before producing. An oversized row is knowable from its length, so
	// it is quarantined here rather than after N round trips that could not have
	// worked — and, decisively, rather than being handed to a producer that
	// would refuse the whole batch because of it.
	sendable := batch[:0:0]
	var oversize []row
	for _, r := range batch {
		if len(r.payload) > maxPublishBytes {
			oversize = append(oversize, r)
			continue
		}
		sendable = append(sendable, r)
	}
	if len(oversize) > 0 {
		if _, err := tx.Exec(ctx,
			`UPDATE outbox
			    SET dead_lettered_at = now(),
			        publish_error = 'payload ' || octet_length(payload::text) ||
			                        ' bytes exceeds the ' || $2 || ' byte publish limit'
			  WHERE id = ANY($1)`, rowIDs(oversize), maxPublishBytes); err != nil {
			return err
		}
		// ERROR, not warn: these are notifications a user's action produced
		// that will never be delivered, and nothing else reports it.
		p.log.Error("outbox rows dead-lettered as oversized; notifications accepted but never published",
			"count", len(oversize))
	}
	if len(sendable) == 0 {
		// Nothing sendable, but the quarantine must persist or the same rows
		// block the queue again on the next tick.
		return tx.Commit(ctx)
	}
	batch = sendable

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
	if werr := p.writer.WriteMessages(ctx, msgs...); werr != nil {
		// Roll back the claim so the locks are released and the rows stay
		// unpublished, then record the attempt SEPARATELY — a counter written
		// inside the rolled-back transaction would be discarded, leaving the
		// row on a permanent retry loop with a permanently zero attempt count.
		_ = tx.Rollback(ctx)
		p.recordPublishFailure(ctx, rowIDs(batch), werr)
		return werr
	}

	ids := rowIDs(batch)
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

// recordPublishFailure bumps the attempt counter for a failed batch and
// quarantines any row that has now exhausted it.
//
// Runs in its OWN transaction, deliberately: publishBatch has just rolled back
// the claim (so the rows are unlocked and still unpublished, which is what
// preserves at-least-once), and a counter written inside that rolled-back
// transaction would be discarded — leaving the row retrying forever with a
// permanently zero attempt count.
//
// Best-effort by design. If this fails, the only loss is the counter, and the
// publisher behaves exactly as it did before: it retries. So it logs rather
// than propagating, and never masks the publish error the caller is returning.
func (p *Publisher) recordPublishFailure(ctx context.Context, ids []uuid.UUID, cause error) {
	// Truncated: this lands in a text column a human reads, and a broker error
	// can carry a very long message.
	reason := cause.Error()
	if len(reason) > 500 {
		reason = reason[:500]
	}

	// ── One UPDATE per row, not two CTEs ─────────────────────────────────────
	// This was a `WITH bumped AS (UPDATE ...), dead AS (UPDATE ... FROM bumped)`
	// pair, and it silently did nothing: Postgres will not modify the same row
	// twice in a single statement, so the second UPDATE matched rows the first
	// had already touched and skipped every one. The counter climbed forever and
	// NOTHING was quarantined — the retry-forever wedge this exists to end,
	// reintroduced by the fix for it. Verified against Postgres 17.
	var quarantined int
	err := p.pool.QueryRow(ctx,
		`WITH bumped AS (
		     UPDATE outbox
		        SET publish_attempts = publish_attempts + 1,
		            publish_error    = $2,
		            dead_lettered_at = CASE
		                WHEN publish_attempts + 1 >= $3 THEN now()
		                ELSE dead_lettered_at
		            END
		      WHERE id = ANY($1) AND published_at IS NULL AND dead_lettered_at IS NULL
		  RETURNING dead_lettered_at
		 )
		 SELECT count(*) FROM bumped WHERE dead_lettered_at IS NOT NULL`,
		ids, reason, maxPublishAttempts).Scan(&quarantined)
	if err != nil {
		p.log.Error("recording outbox publish failure failed", "error", err)
		return
	}
	if quarantined > 0 {
		p.log.Error("outbox rows dead-lettered after repeated failures; notifications accepted but never published",
			"count", quarantined, "attempts", maxPublishAttempts, "cause", reason)
	}
}

func rowIDs(rows []row) []uuid.UUID {
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.id
	}
	return ids
}

// Enqueue inserts an outbox row inside the provided transaction. The payload
// must already be the full, marshaled event JSON.
//
// orgID is stored alongside the payload (not just embedded inside it) so
// purgeOrg can delete a deleted org's not-yet-published rows directly —
// without it, those rows outlive the org and still get published after
// org.deleted, since nothing else ever looks inside the JSON to find them.
func Enqueue(ctx context.Context, tx pgx.Tx, id uuid.UUID, topic, key, orgID string, payload []byte) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO outbox (id, topic, kafka_key, org_id, payload) VALUES ($1, $2, $3, $4, $5)`,
		id, topic, key, orgID, payload)
	return err
}
