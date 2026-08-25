// Package bridge moves events across the region boundary in both directions.
package bridge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/region-bridge/internal/config"
	"github.com/task-board/region-bridge/internal/health"
	"github.com/task-board/region-bridge/internal/loop"
	"github.com/task-board/region-bridge/internal/metrics"
	"github.com/task-board/shared-backoff"
)

// maxPublishAttempts is how many times one batch is retried before its
// unpublishable messages are set aside.
//
// Sized to ride out a real outage rather than a blip: with the capped backoff
// this is roughly twenty minutes of continuous failure. Anything still failing
// after that is not waiting on a recovery, and continuing to retry it costs the
// events queued behind it — the head-of-line block that took the outbox poller
// down once already (see messaging-svc's maxPublishAttempts).
const maxPublishAttempts = 60

// batchLinger is how long a partially-filled batch waits for more messages.
//
// The entire latency cost the bridge adds on the export side, and it buys the
// difference between one WAN round trip per batch and one per event. 25ms is
// invisible next to inter-region RTT and fills a batch comfortably at any real
// message rate.
const batchLinger = 25 * time.Millisecond

// ackTimeout bounds the wait for JetStream to acknowledge a batch. Without it a
// server that accepts a publish and then goes silent parks this goroutine
// forever holding its Kafka offsets — the deadlock this bridge must not have.
const ackTimeout = 30 * time.Second

// Exporter moves locally-produced events onto the cross-region stream.
//
// One goroutine per topic, each with its own Kafka reader and its own retry
// state. Per-topic isolation is deliberate: a single poison event or a single
// unroutable subject then stalls one topic instead of every topic, and the
// blast radius of the worst case is one feature rather than the platform.
type Exporter struct {
	cfg   *config.Config
	js    jetstream.JetStream
	dlq   *kafka.Writer
	state *health.State
	log   *slog.Logger
}

func NewExporter(cfg *config.Config, js jetstream.JetStream, dlq *kafka.Writer, st *health.State, log *slog.Logger) *Exporter {
	return &Exporter{cfg: cfg, js: js, dlq: dlq, state: st, log: log}
}

// Run blocks until ctx is cancelled, bridging every configured topic.
func (e *Exporter) Run(ctx context.Context) {
	e.state.SetEnabled(health.Export, true)
	metrics.Up.WithLabelValues("export").Set(1)
	defer func() {
		e.state.SetEnabled(health.Export, false)
		metrics.Up.WithLabelValues("export").Set(0)
	}()

	done := make(chan struct{}, len(e.cfg.Topics))
	for _, topic := range e.cfg.Topics {
		go func(topic string) {
			defer func() { done <- struct{}{} }()
			e.runTopic(ctx, topic)
		}(topic)
	}
	for range e.cfg.Topics {
		<-done
	}
}

func (e *Exporter) runTopic(ctx context.Context, topic string) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: e.cfg.KafkaBrokers,
		// A group of its own, never an application's. Sharing one would consume
		// events away from the service that needs them — the bridge is an extra
		// reader of the log, not a competitor for it.
		GroupID:  e.cfg.KafkaGroupID,
		Topic:    topic,
		MinBytes: 1,
		MaxBytes: 10 << 20,
		// Offsets are committed EXPLICITLY, after JetStream has acknowledged.
		// The default periodic commit would advance past events that never
		// crossed, and losing an event silently is the one outcome worse than
		// bridging it twice.
		CommitInterval: 0,
	})
	defer func() {
		if err := r.Close(); err != nil {
			e.log.Warn("closing kafka reader", "topic", topic, "err", err)
		}
	}()

	e.log.Info("export started", "topic", topic, "subject", e.cfg.SubjectFor(topic))
	for {
		batch, err := e.collect(ctx, r)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			metrics.Failures.WithLabelValues("export", "fetch").Inc()
			e.state.SetKafka(false)
			e.state.Fault(health.Export, err)
			e.log.Warn("kafka fetch failed", "topic", topic, "err", err)
			if !backoff.Default.Sleep(ctx.Done(), 1) {
				return
			}
			continue
		}
		// A successful fetch is the cheapest honest signal that the local
		// cluster is reachable, and it costs nothing extra.
		e.state.SetKafka(true)
		if len(batch) == 0 {
			continue
		}
		if !e.process(ctx, r, topic, batch) {
			return // shutting down mid-batch; the offsets stay uncommitted
		}
	}
}

// collect reads up to BatchSize messages, waiting at most batchLinger for the
// batch to fill after the first one arrives.
//
// The first read blocks on ctx alone — an idle topic must not spin — and every
// subsequent read is bounded, so this can never wait indefinitely holding a
// partial batch.
func (e *Exporter) collect(ctx context.Context, r *kafka.Reader) ([]kafka.Message, error) {
	first, err := r.FetchMessage(ctx)
	if err != nil {
		return nil, err
	}
	batch := make([]kafka.Message, 0, e.cfg.BatchSize)
	batch = append(batch, first)

	lingerCtx, cancel := context.WithTimeout(ctx, batchLinger)
	defer cancel()
	for len(batch) < e.cfg.BatchSize {
		m, err := r.FetchMessage(lingerCtx)
		if err != nil {
			// Deadline or cancellation: send what we have. Anything else is a
			// real error, but we still have a usable batch in hand and the next
			// loop will surface it.
			break
		}
		batch = append(batch, m)
	}
	return batch, nil
}

// process publishes a batch and commits it. Returns false only when shutting
// down, in which case nothing is committed and the batch is re-read by whoever
// takes over the partition.
func (e *Exporter) process(ctx context.Context, r *kafka.Reader, topic string, batch []kafka.Message) bool {
	// classify first: skips and rejects never reach the network.
	pending := make([]*nats.Msg, len(batch))
	for i, m := range batch {
		prov := provenanceOf(m.Headers)
		decision, reason := loop.ExportDecision(prov, e.cfg.Region)
		switch decision {
		case loop.Skip:
			// The cycle break, and the high-volume path in a busy mesh: every
			// event a peer sent us lands here.
			metrics.Skipped.WithLabelValues("export", reason).Inc()
		case loop.Reject:
			metrics.Rejected.WithLabelValues("export", "returned").Inc()
			e.log.Error("event returned to its origin region — check peer stream sources",
				"topic", topic, "origin", prov.Origin, "reason", reason)
			e.deadLetter(ctx, m, reason)
		default:
			pending[i] = e.natsMsg(topic, m)
		}
	}

	if !e.publishAll(ctx, topic, batch, pending) {
		return false
	}

	// Commit only now. Every message in the batch is either on the cross-region
	// stream, deliberately skipped, or dead-lettered — so advancing past them
	// cannot lose one.
	if err := commitWithRetry(ctx, r, batch); err != nil {
		if ctx.Err() != nil {
			return false
		}
		// The events ARE published; failing to commit only means they will be
		// bridged again after a rebalance, and the dedupe window makes that a
		// no-op. Logged rather than retried forever.
		metrics.Failures.WithLabelValues("export", "commit").Inc()
		e.log.Warn("kafka commit failed; events may be re-bridged (deduped downstream)",
			"topic", topic, "err", err)
	}
	return true
}

// publishAll publishes every not-yet-acked message, retrying the batch until it
// lands or the poison threshold sets the stragglers aside.
//
// Retried IN PLACE rather than by letting Kafka redeliver, because kafka-go's
// reader has already advanced past these messages in this process — "don't
// commit and let it come back" only works across a restart. Holding the batch
// is also what preserves order: nothing after it is read until it is resolved.
func (e *Exporter) publishAll(ctx context.Context, topic string, batch []kafka.Message, pending []*nats.Msg) bool {
	for attempt := 1; ; attempt++ {
		futures, err := e.publishPending(pending)
		// Await regardless of err: publishPending stops at the first failure,
		// but the publishes it already issued are in flight and their acks
		// clear those slots. Skipping the wait would re-send events that had
		// landed — correct, thanks to the dedupe window, but paid for in WAN
		// bandwidth on every retry.
		if ackErr := e.awaitAcks(ctx, futures, pending); err == nil {
			err = ackErr
		}
		if err == nil {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		metrics.Failures.WithLabelValues("export", "publish").Inc()
		e.state.Fault(health.Export, err)

		if attempt >= maxPublishAttempts {
			// Set the stragglers aside so the topic moves again. Dead-lettering
			// beats blocking: the events behind a poison one are healthy, and
			// stalling the whole topic to protect one event is the trade the
			// outbox poller learned not to make.
			for i, msg := range pending {
				if msg == nil {
					continue
				}
				metrics.DLQ.WithLabelValues("export", "publish-failed").Inc()
				e.deadLetter(ctx, batch[i], "publish failed after "+strconv.Itoa(attempt)+" attempts: "+err.Error())
			}
			e.log.Error("dead-lettered unpublishable events", "topic", topic, "attempts", attempt, "err", err)
			return true
		}
		e.log.Warn("publish to jetstream failed; retrying",
			"topic", topic, "attempt", attempt, "err", err)
		if !backoff.Default.Sleep(ctx.Done(), attempt) {
			return false
		}
	}
}

// publishPending fires the async publishes, in order. A nil slot is a message
// that was skipped, dead-lettered, or already acknowledged by an earlier
// attempt — re-sending those would only spend WAN bandwidth the dedupe window
// would then discard.
func (e *Exporter) publishPending(pending []*nats.Msg) ([]jetstream.PubAckFuture, error) {
	futures := make([]jetstream.PubAckFuture, len(pending))
	for i, msg := range pending {
		if msg == nil {
			continue
		}
		f, err := e.js.PublishMsgAsync(msg)
		if err != nil {
			// Includes the stalled-publisher error, which is the async window
			// applying back-pressure. It is a retry, not a fault: the window
			// exists so a slow server becomes slowness rather than an
			// out-of-memory kill.
			return futures, fmt.Errorf("publish %s: %w", msg.Subject, err)
		}
		futures[i] = f
	}
	return futures, nil
}

// awaitAcks waits for every outstanding publish, clearing the ones that landed.
//
// Bounded by ackTimeout and by ctx: a server that accepts a publish and never
// answers must not park this goroutine holding a partition's offsets.
func (e *Exporter) awaitAcks(ctx context.Context, futures []jetstream.PubAckFuture, pending []*nats.Msg) error {
	deadline, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()

	var firstErr error
	for i, f := range futures {
		if f == nil {
			continue
		}
		select {
		case <-f.Ok():
			// Cleared, so a retry of this batch does not re-send it.
			pending[i] = nil
			metrics.Bridged.WithLabelValues("export", topicOf(f.Msg())).Inc()
			metrics.LastSuccess.WithLabelValues("export").Set(float64(time.Now().Unix()))
			e.state.Progress(health.Export)
		case err := <-f.Err():
			if firstErr == nil {
				firstErr = err
			}
		case <-deadline.Done():
			if firstErr == nil {
				firstErr = fmt.Errorf("timed out after %s waiting for jetstream acks", ackTimeout)
			}
			// Stop waiting on the rest: they share one deadline, so every
			// remaining receive would return immediately with the same error.
			return firstErr
		}
	}
	return firstErr
}

// natsMsg builds the cross-region copy: the payload byte-for-byte, plus the
// provenance that makes the return trip impossible.
func (e *Exporter) natsMsg(topic string, m kafka.Message) *nats.Msg {
	msg := nats.NewMsg(e.cfg.SubjectFor(topic))
	msg.Data = m.Value
	msg.Header.Set(loop.HeaderOriginRegion, e.cfg.Region)
	msg.Header.Set(loop.HeaderHops, strconv.Itoa(loop.MaxHops))
	msg.Header.Set(loop.HeaderKafkaTopic, topic)
	msg.Header.Set(loop.HeaderKafkaKey, string(m.Key))

	// Dedupe key. The platform's events already carry a UUIDv7 event id and the
	// producers are idempotent, so this is what turns the bridge's
	// at-least-once retries into effectively-once delivery: a replayed batch
	// republishes the same ids and the server drops them.
	//
	// Falls back to the Kafka coordinates, which are unique per topic and
	// stable across a replay, when an event carries no id of its own.
	id := headerValue(m.Headers, loop.HeaderEventID)
	if id == "" {
		id = fmt.Sprintf("%s-%d-%d", m.Topic, m.Partition, m.Offset)
	}
	msg.Header.Set(jetstream.MsgIDHeader, id)

	// Carry the tracing context across the boundary so one request's spans join
	// up across regions instead of starting again on the far side.
	for _, h := range m.Headers {
		if isTraceHeader(h.Key) {
			msg.Header.Set(h.Key, string(h.Value))
		}
	}
	return msg
}

// deadLetter parks an event that cannot cross, with the reason attached.
//
// Best-effort and never fatal: a DLQ that is itself unavailable must not stop
// the bridge, because the alternative is stalling every healthy event behind
// one broken one. The metric is what makes the loss visible.
func (e *Exporter) deadLetter(ctx context.Context, m kafka.Message, reason string) {
	if e.dlq == nil {
		return
	}
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// No Topic on the message: the writer already carries it, and kafka-go
	// refuses a message that sets both ("Topic must not be specified for both
	// Writer and Message"). Setting it here made every dead-letter write fail —
	// so the one path whose whole job is to not lose an event lost all of them.
	err := e.dlq.WriteMessages(writeCtx, kafka.Message{
		Key:   m.Key,
		Value: m.Value,
		Headers: append(m.Headers,
			kafka.Header{Key: "X-Bridge-Reject-Reason", Value: []byte(reason)},
			kafka.Header{Key: "X-Bridge-Source-Topic", Value: []byte(m.Topic)},
			kafka.Header{Key: "X-Bridge-Region", Value: []byte(e.cfg.Region)},
		),
	})
	if err != nil {
		e.log.Error("dead-letter write failed; event is lost", "topic", m.Topic, "err", err)
	}
}

// commitWithRetry commits the batch, retrying a handful of times. A commit is
// cheap and idempotent, and failing to commit costs a re-bridge rather than
// data, so this gives up quickly rather than holding the topic.
func commitWithRetry(ctx context.Context, r *kafka.Reader, batch []kafka.Message) error {
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		if err = r.CommitMessages(ctx, batch...); err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !backoff.Default.Sleep(ctx.Done(), attempt) {
			return errors.New("shutting down before commit")
		}
	}
	return err
}
