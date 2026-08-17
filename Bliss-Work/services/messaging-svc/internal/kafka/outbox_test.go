package kafka

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/task-board/messaging-svc/internal/store"
)

// The whole point of the batch change is that a drain produces ONE Kafka write
// for N rows. That is only correct if the batch it builds is one message per
// row, in the order the outbox claimed them — per-key ordering downstream
// depends on it, since kafka-go preserves order within a batch per partition.
func TestBuildMessagesIsOneForOneAndOrdered(t *testing.T) {
	rows := []store.OutboxRow{
		{ID: "1", Topic: "messaging.events.v1", Key: "conv-a", Payload: []byte(`{"n":1}`)},
		{ID: "2", Topic: "messaging.events.v1", Key: "conv-a", Payload: []byte(`{"n":2}`)},
		{ID: "3", Topic: "task.events.v1", Key: "task-b", Payload: []byte(`{"n":3}`)},
	}
	msgs := buildMessages(context.Background(), otel.Tracer("test"), rows)

	if len(msgs) != len(rows) {
		t.Fatalf("built %d messages from %d rows; the batch must be one for one", len(msgs), len(rows))
	}
	for i, r := range rows {
		if msgs[i].Topic != r.Topic {
			t.Errorf("msg %d topic = %q, want %q", i, msgs[i].Topic, r.Topic)
		}
		if string(msgs[i].Key) != r.Key {
			t.Errorf("msg %d key = %q, want %q — the Hash balancer partitions on this, "+
				"so a wrong key silently breaks per-conversation ordering",
				i, msgs[i].Key, r.Key)
		}
		if string(msgs[i].Value) != string(r.Payload) {
			t.Errorf("msg %d value = %q, want %q", i, msgs[i].Value, r.Payload)
		}
	}
}

// Trace context must land on the message that is actually SENT.
//
// The failure this guards is invisible at runtime: injecting into a loop copy
// rather than into &msgs[i] produces a perfectly valid batch with no headers on
// it, so the producer→consumer trace link disappears and nothing errors. It is
// exactly the mistake a rewrite of this loop invites.
func TestBuildMessagesStampsTraceHeadersOnTheSentMessage(t *testing.T) {
	// A real tracer provider and propagator: with the global no-op tracer the
	// span context is never valid and the propagator injects nothing, so this
	// test would pass against a broken implementation.
	prev := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(prev) })
	otel.SetTextMapPropagator(propagation.TraceContext{})

	tracer := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	).Tracer("test")

	rows := []store.OutboxRow{
		{ID: "1", Topic: "messaging.events.v1", Key: "k1", Payload: []byte(`{}`)},
		{ID: "2", Topic: "messaging.events.v1", Key: "k2", Payload: []byte(`{}`)},
	}
	msgs := buildMessages(context.Background(), tracer, rows)

	for i, m := range msgs {
		var found bool
		for _, h := range m.Headers {
			if h.Key == "traceparent" {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("message %d carries no traceparent header; the injection went to a "+
				"copy rather than to the message in the batch, so the trace link is lost",
				i)
		}
	}
}

// An empty claim must produce an empty batch rather than a one-element slice of
// zero values — WriteMessages on a message with no topic is an error, and the
// drain path reaches here whenever the outbox is idle, which is most ticks.
func TestBuildMessagesHandlesAnEmptyBatch(t *testing.T) {
	if msgs := buildMessages(context.Background(), otel.Tracer("test"), nil); len(msgs) != 0 {
		t.Fatalf("built %d messages from no rows, want 0", len(msgs))
	}
}
