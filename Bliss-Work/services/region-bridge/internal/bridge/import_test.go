package bridge

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/protocol"
	"github.com/segmentio/kafka-go/protocol/metadata"
	"github.com/segmentio/kafka-go/protocol/produce"

	"github.com/task-board/region-bridge/internal/config"
	"github.com/task-board/region-bridge/internal/health"
	"github.com/task-board/region-bridge/internal/loop"
	"github.com/task-board/region-bridge/internal/streams"
)

// With dead-lettering DISABLED the importer used to NAK every poison message
// (a loop-guard rejection, no/unknown topic, exhausted redeliveries). Nothing
// ever changed about them, so they recycled until JetStream's MaxDeliver (64)
// and then vanished with no record. A poison message must be Term()'d whatever
// the DLQ setting; only a transient write failure may be NAK'd.

// ── Fakes ────────────────────────────────────────────────────────────────────

// fakeMsg records how a message was settled. Unimplemented jetstream.Msg
// methods panic (nil embedded interface), so an unexpected call fails loudly.
type fakeMsg struct {
	jetstream.Msg
	subject   string
	hdr       nats.Header
	data      []byte
	delivered uint64

	mu      sync.Mutex
	settled []string
}

func (m *fakeMsg) Subject() string      { return m.subject }
func (m *fakeMsg) Headers() nats.Header { return m.hdr }
func (m *fakeMsg) Data() []byte         { return m.data }
func (m *fakeMsg) Metadata() (*jetstream.MsgMetadata, error) {
	return &jetstream.MsgMetadata{NumDelivered: m.delivered}, nil
}
func (m *fakeMsg) record(how string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settled = append(m.settled, how)
	return nil
}
func (m *fakeMsg) Ack() error                       { return m.record("ack") }
func (m *fakeMsg) Nak() error                       { return m.record("nak") }
func (m *fakeMsg) NakWithDelay(time.Duration) error { return m.record("nak") }
func (m *fakeMsg) Term() error                      { return m.record("term") }
func (m *fakeMsg) outcome() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.settled...)
}

type fakeBatch struct {
	ch chan jetstream.Msg
}

func (b fakeBatch) Messages() <-chan jetstream.Msg { return b.ch }
func (b fakeBatch) Error() error                   { return nil }

type fakeConsumer struct {
	jetstream.Consumer
	msgs []jetstream.Msg
}

func (c *fakeConsumer) Fetch(int, ...jetstream.FetchOpt) (jetstream.MessageBatch, error) {
	ch := make(chan jetstream.Msg, len(c.msgs))
	for _, m := range c.msgs {
		ch <- m
	}
	close(ch)
	return fakeBatch{ch}, nil
}

// fakeKafka is a kafka.RoundTripper standing in for a broker: it answers
// metadata, and either accepts or refuses produce requests, recording each.
type fakeKafka struct {
	failProduce bool

	mu       sync.Mutex
	produced []producedRecord
}

type producedRecord struct {
	topic   string
	headers map[string]string
}

func (k *fakeKafka) RoundTrip(_ context.Context, _ net.Addr, req kafka.Request) (kafka.Response, error) {
	switch r := req.(type) {
	case *metadata.Request:
		topics := make([]metadata.ResponseTopic, 0, len(r.TopicNames))
		for _, name := range r.TopicNames {
			topics = append(topics, metadata.ResponseTopic{
				Name:       name,
				Partitions: []metadata.ResponsePartition{{PartitionIndex: 0}},
			})
		}
		return &metadata.Response{Topics: topics}, nil
	case *produce.Request:
		if k.failProduce {
			return nil, errors.New("broker unreachable")
		}
		resp := &produce.Response{}
		for _, t := range r.Topics {
			rt := produce.ResponseTopic{Topic: t.Topic}
			for _, p := range t.Partitions {
				rt.Partitions = append(rt.Partitions, produce.ResponsePartition{Partition: p.Partition})
				k.capture(t.Topic, p.RecordSet)
			}
			resp.Topics = append(resp.Topics, rt)
		}
		return resp, nil
	}
	return nil, errors.New("unexpected request")
}

func (k *fakeKafka) capture(topic string, rs protocol.RecordSet) {
	for {
		rec, err := rs.Records.ReadRecord()
		if err != nil {
			return
		}
		h := map[string]string{}
		for _, hh := range rec.Headers {
			h[hh.Key] = string(hh.Value)
		}
		k.mu.Lock()
		k.produced = append(k.produced, producedRecord{topic: topic, headers: h})
		k.mu.Unlock()
	}
}

func (k *fakeKafka) records() []producedRecord {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]producedRecord(nil), k.produced...)
}

func newWriter(k *fakeKafka, topic string) *kafka.Writer {
	return &kafka.Writer{
		Addr:        kafka.TCP("fake:9092"),
		Topic:       topic,
		Transport:   k,
		Balancer:    &kafka.Hash{},
		MaxAttempts: 1,
		BatchSize:   1,
		// Synchronous: WriteMessages must return the produce result.
	}
}

const region = "eu"

func testImporter(cons jetstream.Consumer, main, dlq *kafka.Writer) *Importer {
	cfg := &config.Config{Region: region, Peers: []string{"us"}, Topics: []string{"events"}, BatchSize: 10}
	return NewImporter(cfg, cons, main, dlq, health.New(time.Minute), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func goodHeaders() nats.Header {
	h := nats.Header{}
	h.Set(loop.HeaderOriginRegion, "us")
	h.Set(loop.HeaderHops, "0")
	h.Set(loop.HeaderKafkaTopic, "events")
	h.Set(loop.HeaderKafkaKey, "k")
	return h
}

func msgWith(mut func(h nats.Header), delivered uint64) *fakeMsg {
	h := goodHeaders()
	if mut != nil {
		mut(h)
	}
	return &fakeMsg{subject: "evt.us.events", hdr: h, data: []byte(`{"x":1}`), delivered: delivered}
}

// ── Poison messages are terminated whether or not a DLQ exists ────────────────

func poisonCases() map[string]*fakeMsg {
	return map[string]*fakeMsg{
		"unknown topic": msgWith(func(h nats.Header) { h.Set(loop.HeaderKafkaTopic, "not-bridged") }, 1),
		"missing topic": msgWith(func(h nats.Header) { h.Del(loop.HeaderKafkaTopic) }, 1),
		"own origin":    msgWith(func(h nats.Header) { h.Set(loop.HeaderOriginRegion, region) }, 1),
		"no origin":     msgWith(func(h nats.Header) { h.Del(loop.HeaderOriginRegion) }, 1),
		"hop limit":     msgWith(func(h nats.Header) { h.Set(loop.HeaderHops, "5") }, 1),
	}
}

func TestImport_PoisonMessageIsTerminatedWhenDLQIsDisabled(t *testing.T) {
	for name, msg := range poisonCases() {
		t.Run(name, func(t *testing.T) {
			imp := testImporter(nil, newWriter(&fakeKafka{}, ""), nil) // dlq == nil: disabled
			if _, ok := imp.classify(msg); ok {
				t.Fatal("poison message was accepted for writing")
			}
			if got := msg.outcome(); len(got) != 1 || got[0] != "term" {
				t.Fatalf("settled as %v, want exactly [term]: a NAK recycles it until MaxDeliver and then it vanishes", got)
			}
		})
	}
}

func TestImport_PoisonMessageIsTerminatedAndDeadLetteredWhenDLQIsEnabled(t *testing.T) {
	for name, msg := range poisonCases() {
		t.Run(name, func(t *testing.T) {
			dlqKafka := &fakeKafka{}
			imp := testImporter(nil, newWriter(&fakeKafka{}, ""), newWriter(dlqKafka, "bridge-dlq"))
			if _, ok := imp.classify(msg); ok {
				t.Fatal("poison message was accepted for writing")
			}
			if got := msg.outcome(); len(got) != 1 || got[0] != "term" {
				t.Fatalf("settled as %v, want exactly [term]", got)
			}
			recs := dlqKafka.records()
			if len(recs) != 1 || recs[0].topic != "bridge-dlq" || recs[0].headers["X-Bridge-Reject-Reason"] == "" {
				t.Fatalf("DLQ records = %+v, want one on bridge-dlq carrying X-Bridge-Reject-Reason", recs)
			}
		})
	}
}

// ── Redelivery exhaustion ────────────────────────────────────────────────────

func TestImport_WithoutDLQTransientFailuresKeepTheFullRetryBudget(t *testing.T) {
	// Past the DLQ-mode threshold, but a write failure is not poison: with no DLQ
	// the event must still be offered to Kafka instead of being given up on.
	msg := msgWith(nil, maxRedeliveries+1)
	imp := testImporter(nil, newWriter(&fakeKafka{}, ""), nil)
	if _, ok := imp.classify(msg); !ok {
		t.Fatalf("event on delivery %d was refused; with no DLQ it must keep being retried", maxRedeliveries+1)
	}
	if got := msg.outcome(); len(got) != 0 {
		t.Fatalf("settled as %v before its write was even attempted", got)
	}
}

func TestImport_WithoutDLQLastDeliveryIsTerminatedNotNakedIntoTheServerDrop(t *testing.T) {
	msg := msgWith(nil, streams.MaxDeliver) // the server will not deliver it again
	imp := testImporter(nil, newWriter(&fakeKafka{}, ""), nil)
	if _, ok := imp.classify(msg); ok {
		t.Fatal("event on its final delivery was accepted")
	}
	if got := msg.outcome(); len(got) != 1 || got[0] != "term" {
		t.Fatalf("settled as %v, want [term] (explicit and logged, not a silent server-side drop)", got)
	}
}

func TestImport_WithDLQExhaustedRedeliveriesAreTerminated(t *testing.T) {
	msg := msgWith(nil, maxRedeliveries+1)
	imp := testImporter(nil, newWriter(&fakeKafka{}, ""), newWriter(&fakeKafka{}, "bridge-dlq"))
	if _, ok := imp.classify(msg); ok {
		t.Fatal("exhausted event was accepted")
	}
	if got := msg.outcome(); len(got) != 1 || got[0] != "term" {
		t.Fatalf("settled as %v, want [term]", got)
	}
}

// ── Only a transient write failure may NAK ───────────────────────────────────

func TestImport_TransientKafkaFailureNaksTheBatchAndTermsNothing(t *testing.T) {
	good := msgWith(nil, 1)
	imp := testImporter(&fakeConsumer{msgs: []jetstream.Msg{good}}, newWriter(&fakeKafka{failProduce: true}, ""), nil)

	if _, err := imp.fetchAndWrite(context.Background()); err == nil {
		t.Fatal("fetchAndWrite reported success although the Kafka write failed")
	}
	if got := good.outcome(); len(got) != 1 || got[0] != "nak" {
		t.Fatalf("settled as %v, want [nak]: a transient failure must be retried, never terminated", got)
	}
}

func TestImport_MixedBatchTermsPoisonAndAcksTheRest(t *testing.T) {
	good := msgWith(nil, 1)
	bad := msgWith(func(h nats.Header) { h.Set(loop.HeaderKafkaTopic, "not-bridged") }, 1)
	out := &fakeKafka{}
	imp := testImporter(&fakeConsumer{msgs: []jetstream.Msg{bad, good}}, newWriter(out, ""), nil)

	n, err := imp.fetchAndWrite(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("fetchAndWrite = %d, %v; want 1, nil", n, err)
	}
	if got := bad.outcome(); len(got) != 1 || got[0] != "term" {
		t.Errorf("poison settled as %v, want [term]", got)
	}
	if got := good.outcome(); len(got) != 1 || got[0] != "ack" {
		t.Errorf("good message settled as %v, want [ack]", got)
	}
	if recs := out.records(); len(recs) != 1 || recs[0].topic != "events" {
		t.Errorf("records written = %+v, want just the good one on %q", recs, "events")
	}
}
