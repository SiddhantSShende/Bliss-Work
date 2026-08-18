package bridge

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/region-bridge/internal/backoff"
	"github.com/task-board/region-bridge/internal/config"
	"github.com/task-board/region-bridge/internal/health"
	"github.com/task-board/region-bridge/internal/loop"
	"github.com/task-board/region-bridge/internal/metrics"
)

// maxRedeliveries is how many times one event may be handed back before it is
// treated as poison rather than as unlucky.
//
// Below the consumer's server-side MaxDeliver on purpose: the bridge decides
// when something is poison and records why, and a server limit that fired first
// would stop delivery with nothing written down.
const maxRedeliveries = 8

// fetchWait is how long a fetch waits for messages before returning empty. It
// bounds shutdown latency — the loop cannot notice cancellation while parked in
// a fetch — and an idle region spends its time here rather than spinning.
const fetchWait = 5 * time.Second

// pendingInterval is how often the import backlog is refreshed. It is one API
// call per tick and the number only drives a gauge and the stall check, so it
// is deliberately far cheaper than reading it per batch.
const pendingInterval = 15 * time.Second

// Importer writes events replicated from peer regions into the local Kafka.
type Importer struct {
	cfg      *config.Config
	consumer jetstream.Consumer
	writer   *kafka.Writer
	dlq      *kafka.Writer
	state    *health.State
	log      *slog.Logger
}

func NewImporter(cfg *config.Config, cons jetstream.Consumer, w, dlq *kafka.Writer, st *health.State, log *slog.Logger) *Importer {
	return &Importer{cfg: cfg, consumer: cons, writer: w, dlq: dlq, state: st, log: log}
}

// Run blocks until ctx is cancelled.
func (i *Importer) Run(ctx context.Context) {
	if i.consumer == nil {
		i.log.Info("import idle: no peer regions configured")
		return
	}
	i.state.SetEnabled(health.Import, true)
	metrics.Up.WithLabelValues("import").Set(1)
	defer func() {
		i.state.SetEnabled(health.Import, false)
		metrics.Up.WithLabelValues("import").Set(0)
	}()

	go i.trackPending(ctx)

	i.log.Info("import started", "consumer", i.consumer.CachedInfo().Name, "peers", i.cfg.Peers)
	for attempt := 0; ; {
		if ctx.Err() != nil {
			return
		}
		n, err := i.fetchAndWrite(ctx)
		switch {
		case err != nil && ctx.Err() != nil:
			return
		case err != nil:
			attempt++
			metrics.Failures.WithLabelValues("import", "batch").Inc()
			i.state.Fault(health.Import, err)
			i.log.Warn("import batch failed; retrying", "attempt", attempt, "err", err)
			if !backoff.Default.Sleep(ctx.Done(), attempt) {
				return
			}
		default:
			// Reset only on a clean pass, so a flapping dependency does not
			// keep restarting the backoff at its shortest delay.
			attempt = 0
			if n > 0 {
				i.state.Progress(health.Import)
			}
		}
	}
}

// fetchAndWrite pulls one batch, writes the acceptable events to local Kafka
// and settles every message. Returns how many events were written.
//
// Nothing is acknowledged before the Kafka write returns, so a crash mid-batch
// redelivers rather than loses. The duplicate that produces is harmless: every
// consumer in the platform already dedupes on the event id (see the
// consumed_events table), which is what makes at-least-once the right trade
// here.
func (i *Importer) fetchAndWrite(ctx context.Context) (int, error) {
	batch, err := i.consumer.Fetch(i.cfg.BatchSize, jetstream.FetchMaxWait(fetchWait))
	if err != nil {
		return 0, err
	}

	var (
		msgs   []kafka.Message
		accept []jetstream.Msg
	)
	// Drain the channel fully before doing anything slow with it: the client
	// closes it when the batch is complete, and leaving it half-read holds the
	// fetch open against the consumer's in-flight budget.
	for msg := range batch.Messages() {
		km, ok := i.classify(msg)
		if !ok {
			continue // already settled (terminated + dead-lettered)
		}
		msgs = append(msgs, km)
		accept = append(accept, msg)
	}
	if err := batch.Error(); err != nil {
		return 0, err
	}
	if len(msgs) == 0 {
		return 0, nil
	}

	// One write for the whole batch. Order within a partition is preserved by
	// the writer, which is the guarantee the origin region's Kafka gave us and
	// the one worth carrying across.
	writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := i.writer.WriteMessages(writeCtx, msgs...); err != nil {
		i.state.SetKafka(false)
		// Hand the whole batch back rather than picking apart which of them
		// landed. JetStream redelivers it after the delay, the events that did
		// land are deduped downstream by event id, and ordering is preserved
		// because nothing after this batch is fetched until it settles.
		i.nakAll(accept, err)
		return 0, err
	}

	i.state.SetKafka(true)
	for n, msg := range accept {
		if err := msg.Ack(); err != nil {
			// The event IS in local Kafka. A failed ack only means JetStream
			// will offer it again, which the downstream dedupe absorbs.
			i.log.Warn("ack failed after a successful write; the event may be re-imported", "err", err)
		}
		metrics.Bridged.WithLabelValues("import", msgs[n].Topic).Inc()
	}
	metrics.LastSuccess.WithLabelValues("import").Set(float64(time.Now().Unix()))
	return len(msgs), nil
}

// classify applies the import guard and converts an accepted event into the
// local Kafka record. Returns ok=false when the message has been settled here
// and must not be written.
func (i *Importer) classify(msg jetstream.Msg) (kafka.Message, bool) {
	hdr := msg.Headers()
	prov := natsProvenanceOf(hdr)
	topic := hdr.Get(loop.HeaderKafkaTopic)

	decision, reason := loop.ImportDecision(prov, i.cfg.Region)
	if decision != loop.Forward {
		metrics.Rejected.WithLabelValues("import", rejectLabel(prov, i.cfg.Region)).Inc()
		i.log.Error("refusing an event at the region boundary",
			"subject", msg.Subject(), "origin", prov.Origin, "hops", prov.Hops, "reason", reason)
		i.terminate(msg, reason)
		return kafka.Message{}, false
	}
	if topic == "" {
		// Without a topic there is nowhere to put it, and guessing from the
		// subject would let a malformed publisher choose a destination.
		metrics.Rejected.WithLabelValues("import", "no-topic").Inc()
		i.terminate(msg, "missing "+loop.HeaderKafkaTopic)
		return kafka.Message{}, false
	}
	if !i.bridged(topic) {
		// A topic this region does not bridge. Refusing rather than writing it
		// keeps the destination set to the one in configuration — otherwise a
		// peer that adds a topic starts writing into our cluster unannounced.
		metrics.Rejected.WithLabelValues("import", "unknown-topic").Inc()
		i.terminate(msg, "topic not in BRIDGE_TOPICS: "+topic)
		return kafka.Message{}, false
	}
	if md, err := msg.Metadata(); err == nil && md.NumDelivered > maxRedeliveries {
		metrics.DLQ.WithLabelValues("import", "redelivery-exhausted").Inc()
		i.log.Error("dead-lettering an event that will not write",
			"subject", msg.Subject(), "deliveries", md.NumDelivered)
		i.terminate(msg, "redelivered "+strconv.FormatUint(md.NumDelivered, 10)+" times")
		return kafka.Message{}, false
	}

	km := kafka.Message{
		Topic: topic,
		Key:   []byte(hdr.Get(loop.HeaderKafkaKey)),
		Value: msg.Data(),
		// The origin travels ON the local record. This is what the local
		// exporter reads to decline re-exporting it — the message-level half of
		// the cycle break, and the reason import must never strip it.
		Headers: []kafka.Header{
			{Key: loop.HeaderOriginRegion, Value: []byte(prov.Origin)},
			{Key: loop.HeaderHops, Value: []byte(strconv.Itoa(prov.Hops))},
		},
	}
	if id := hdr.Get(jetstream.MsgIDHeader); id != "" {
		km.Headers = append(km.Headers, kafka.Header{Key: loop.HeaderEventID, Value: []byte(id)})
	}
	for _, name := range []string{"Traceparent", "Tracestate", "Baggage"} {
		if v := hdr.Get(name); v != "" {
			km.Headers = append(km.Headers, kafka.Header{Key: name, Value: []byte(v)})
		}
	}
	return km, true
}

func (i *Importer) bridged(topic string) bool {
	for _, t := range i.cfg.Topics {
		if t == topic {
			return true
		}
	}
	return false
}

// terminate settles a message that must never be redelivered, and parks a copy
// where a human can find it.
//
// Term rather than Nak: everything routed here fails for a reason redelivery
// cannot change, and a permanent failure on an infinite retry is how a consumer
// stops making progress at all.
func (i *Importer) terminate(msg jetstream.Msg, reason string) {
	if i.dlq != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		hdr := msg.Headers()
		// No Topic on the message — see the note in export.go's deadLetter.
		err := i.dlq.WriteMessages(ctx, kafka.Message{
			Key:   []byte(hdr.Get(loop.HeaderKafkaKey)),
			Value: msg.Data(),
			Headers: []kafka.Header{
				{Key: "X-Bridge-Reject-Reason", Value: []byte(reason)},
				{Key: "X-Bridge-Subject", Value: []byte(msg.Subject())},
				{Key: loop.HeaderOriginRegion, Value: []byte(hdr.Get(loop.HeaderOriginRegion))},
				{Key: "X-Bridge-Region", Value: []byte(i.cfg.Region)},
			},
		})
		if err != nil {
			i.log.Error("dead-letter write failed; event is lost", "subject", msg.Subject(), "err", err)
		}
	}
	if err := msg.Term(); err != nil {
		i.log.Warn("terminate failed; the event will be redelivered", "err", err)
	}
}

// nakAll hands a batch back for redelivery after a transient failure, with a
// delay so it does not return while the cause is still there.
func (i *Importer) nakAll(msgs []jetstream.Msg, cause error) {
	delay := backoff.Default.Delay(1)
	for _, m := range msgs {
		if err := m.NakWithDelay(delay); err != nil {
			// Not fatal: an un-NAK'd message is redelivered when AckWait
			// expires. Slower, but nothing is lost.
			i.log.Debug("nak failed; falling back to the ack-wait timeout", "err", err)
		}
	}
	i.log.Warn("handed a batch back for redelivery", "count", len(msgs), "err", cause)
}

// trackPending publishes the import backlog — the number every cross-region
// runbook starts from, and half of the stall check in /readyz.
func (i *Importer) trackPending(ctx context.Context) {
	t := time.NewTicker(pendingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			infoCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			info, err := i.consumer.Info(infoCtx)
			cancel()
			if err != nil {
				// Not a fault worth failing readiness for on its own: the
				// number is observability, and NATS being unreachable is
				// already reported by the connection handler.
				i.log.Debug("consumer info failed", "err", err)
				continue
			}
			metrics.Pending.Set(float64(info.NumPending))
			i.state.SetPending(info.NumPending)
		}
	}
}

// rejectLabel keeps the metric's cardinality fixed while still separating the
// one reason that means a cycle is forming from the ones that mean a bad
// publisher.
func rejectLabel(p loop.Provenance, region string) string {
	switch {
	case p.Origin == region:
		return "returned"
	case p.Origin == "":
		return "no-origin"
	default:
		return "hop-limit"
	}
}
