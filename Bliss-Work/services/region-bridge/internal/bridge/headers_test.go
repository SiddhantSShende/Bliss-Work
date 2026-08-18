package bridge

import (
	"testing"

	"github.com/nats-io/nats.go"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/region-bridge/internal/loop"
)

// The two transports disagree about header case, and the provenance headers are
// what stand between an active-active mesh and a replication cycle. A header
// that reads as absent because of its spelling is read as "locally produced",
// which is the one wrong answer that loops.

func TestKafkaHeadersAreReadCaseInsensitively(t *testing.T) {
	// NATS canonicalizes to X-Origin-Region; a Kafka client is free to write
	// whatever case it likes, and some do.
	for _, spelling := range []string{"X-Origin-Region", "x-origin-region", "X-ORIGIN-REGION"} {
		hdrs := []kafka.Header{{Key: spelling, Value: []byte("eu-west-1")}}
		if got := provenanceOf(hdrs).Origin; got != "eu-west-1" {
			t.Errorf("header %q read as %q — a missed origin is read as 'local' and loops", spelling, got)
		}
	}
}

func TestAbsentProvenanceReadsAsLocallyProduced(t *testing.T) {
	// Every event a local service writes arrives with no bridge headers at all,
	// so this is the normal case, not an edge one.
	p := provenanceOf(nil)
	if p.Origin != "" || p.Hops != 0 {
		t.Fatalf("bare event read as %+v, want the zero provenance", p)
	}
	if d, _ := loop.ExportDecision(p, "us-east-1"); d != loop.Forward {
		t.Fatalf("a bare local event was not forwarded")
	}
}

func TestNatsProvenanceSurvivesCanonicalization(t *testing.T) {
	h := nats.Header{}
	h.Set(loop.HeaderOriginRegion, "ap-south-1")
	h.Set(loop.HeaderHops, "1")
	p := natsProvenanceOf(h)
	if p.Origin != "ap-south-1" || p.Hops != 1 {
		t.Fatalf("provenance round trip lost data: %+v", p)
	}
}

func TestAMalformedHopHeaderIsTreatedAsALoop(t *testing.T) {
	hdrs := []kafka.Header{
		{Key: loop.HeaderOriginRegion, Value: []byte("eu-west-1")},
		{Key: loop.HeaderHops, Value: []byte("not-a-number")},
	}
	if got := provenanceOf(hdrs).Hops; got <= loop.MaxHops {
		t.Fatalf("unreadable hop counter read as %d; it must fail towards 'stop'", got)
	}
}

func TestTraceHeadersAreForwardedAndNothingElseIs(t *testing.T) {
	for _, yes := range []string{"traceparent", "Traceparent", "tracestate", "baggage"} {
		if !isTraceHeader(yes) {
			t.Errorf("%q should cross the boundary so spans join up", yes)
		}
	}
	for _, no := range []string{"X-Origin-Region", "content-type", "X-Bridge-Hops", ""} {
		if isTraceHeader(no) {
			t.Errorf("%q should not be copied verbatim", no)
		}
	}
}

func TestTopicLabelFallsBackRatherThanBlowingUpCardinality(t *testing.T) {
	if got := topicOf(nil); got != "unknown" {
		t.Errorf("topicOf(nil) = %q", got)
	}
	m := nats.NewMsg("evt.us-east-1.messaging.events.v1")
	if got := topicOf(m); got != "unknown" {
		t.Errorf("a message with no topic header = %q, want unknown", got)
	}
	m.Header.Set(loop.HeaderKafkaTopic, "messaging.events.v1")
	if got := topicOf(m); got != "messaging.events.v1" {
		t.Errorf("topicOf = %q", got)
	}
}

func TestRejectLabelSeparatesACycleFromABadPublisher(t *testing.T) {
	// The one label that must be alertable on its own: `returned` means a
	// replication cycle is forming, and nothing else here does.
	if got := rejectLabel(loop.Provenance{Origin: "us-east-1"}, "us-east-1"); got != "returned" {
		t.Errorf("own-region rejection labelled %q, want returned", got)
	}
	if got := rejectLabel(loop.Provenance{}, "us-east-1"); got != "no-origin" {
		t.Errorf("missing origin labelled %q", got)
	}
	if got := rejectLabel(loop.Provenance{Origin: "eu-west-1", Hops: 9}, "us-east-1"); got != "hop-limit" {
		t.Errorf("over-travelled event labelled %q", got)
	}
}
