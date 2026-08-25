package streams

import (
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/task-board/region-bridge/internal/config"
)

// cfg mirrors what config.Load produces, defaults included — the builders read
// those bounds straight through, so a test that left them zero would assert
// against a configuration the loader refuses to produce.
func cfg() *config.Config {
	return &config.Config{
		Region:         "us-east-1",
		Peers:          []string{"eu-west-1", "ap-south-1"},
		BatchSize:      256,
		MaxAckPending:  2048,
		StreamMaxAge:   24 * time.Hour,
		StreamMaxBytes: 32 << 30,
		StreamReplicas: 3,
		DedupeWindow:   2 * time.Hour,
	}
}

// Three ways a mesh becomes a cycle, all of them one field in a config file.
// Finding them any other way means finding them in production, from a graph of
// WAN egress that will not stop climbing.

func TestAnInboundStreamWithSubjectsIsRefused(t *testing.T) {
	// The subtlest one. `evt.>` looks like "receive everything" and is: it also
	// captures the LOCAL region's publishes, which the importer then writes back
	// into local Kafka, where the exporter reads them as… local events.
	err := AssertCannotLoop(&jetstream.StreamConfig{
		Name:     "EVENTS_IN_US_EAST_1",
		Subjects: []string{"evt.>"},
	}, cfg())
	if err == nil {
		t.Fatal("an inbound stream with its own subjects was accepted")
	}
	if !strings.Contains(err.Error(), "source only") {
		t.Errorf("the error must say what to do about it, got: %v", err)
	}
}

func TestSourcingOurOwnOutboundStreamIsRefused(t *testing.T) {
	err := AssertCannotLoop(&jetstream.StreamConfig{
		Name: "EVENTS_IN_US_EAST_1",
		Sources: []*jetstream.StreamSource{
			{Name: "EVENTS_OUT_EU_WEST_1"},
			{Name: "EVENTS_OUT_US_EAST_1"}, // ← ourselves
		},
	}, cfg())
	if err == nil {
		t.Fatal("sourcing our own outbound stream was accepted — that is a one-hop cycle")
	}
}

func TestSourcingAPeersInboundStreamIsRefused(t *testing.T) {
	// A→B and B→A both sourcing each other's INBOUND streams re-replicates
	// every event on every hop: the traffic multiplies per round trip rather
	// than settling.
	err := AssertCannotLoop(&jetstream.StreamConfig{
		Name:    "EVENTS_IN_US_EAST_1",
		Sources: []*jetstream.StreamSource{{Name: "EVENTS_IN_EU_WEST_1"}},
	}, cfg())
	if err == nil {
		t.Fatal("sourcing a peer's inbound stream was accepted")
	}
	if !strings.Contains(err.Error(), "outbound") {
		t.Errorf("the error must name the fix, got: %v", err)
	}
}

func TestTheCorrectTopologyIsAccepted(t *testing.T) {
	err := AssertCannotLoop(&jetstream.StreamConfig{
		Name: "EVENTS_IN_US_EAST_1",
		Sources: []*jetstream.StreamSource{
			{Name: "EVENTS_OUT_EU_WEST_1", FilterSubject: "evt.eu-west-1.>"},
			{Name: "EVENTS_OUT_AP_SOUTH_1", FilterSubject: "evt.ap-south-1.>"},
		},
	}, cfg())
	if err != nil {
		t.Fatalf("the intended topology was refused: %v", err)
	}
}

func TestOutboundStreamCapturesOnlyItsOwnRegion(t *testing.T) {
	// The structural half of loop prevention: a peer sources this stream, so
	// anything it captures crosses the WAN. It must never be able to hold an
	// event that came FROM a peer.
	got := outboundConfig(cfg())
	if len(got.Subjects) != 1 || got.Subjects[0] != "evt.us-east-1.>" {
		t.Fatalf("outbound subjects = %v, want exactly [evt.us-east-1.>]", got.Subjects)
	}
	if got.Duplicates <= 0 {
		t.Error("no dedupe window: the exporter's retries would deliver duplicates across the WAN")
	}
	if got.MaxBytes <= 0 || got.MaxAge <= 0 {
		t.Error("an unbounded replication log takes the region's JetStream store down with it")
	}
}

func TestInboundStreamHasNoSubjectsAndSourcesEveryPeer(t *testing.T) {
	got := inboundConfig(cfg())
	if len(got.Subjects) != 0 {
		t.Fatalf("inbound subjects = %v, want none", got.Subjects)
	}
	if len(got.Sources) != 2 {
		t.Fatalf("sources = %d, want one per peer", len(got.Sources))
	}
	for _, src := range got.Sources {
		if !strings.HasPrefix(src.Name, "EVENTS_OUT_") {
			t.Errorf("source %q is not a peer's outbound stream", src.Name)
		}
		if src.FilterSubject == "" {
			t.Errorf("source %q has no subject filter", src.Name)
		}
	}
}

func TestStreamsArePlacedInThisRegionsOwnCluster(t *testing.T) {
	// Proven live, the hard way: a gateway between two JetStream-enabled
	// clusters forms ONE combined meta-cluster regardless of `domain` (verified
	// directly — two gatewayed 3-node regions reported cluster_size 6), so
	// without an explicit Placement, stream creation can be refused outright
	// ("no suitable peers for placement") rather than land predictably in one
	// region. Placement.Cluster is what actually keeps a region's replicas from
	// crossing the gateway.
	c := cfg()
	if got := outboundConfig(c).Placement; got == nil || got.Cluster != c.Region {
		t.Fatalf("outbound placement = %+v, want cluster %q", got, c.Region)
	}
	if got := inboundConfig(c).Placement; got == nil || got.Cluster != c.Region {
		t.Fatalf("inbound placement = %+v, want cluster %q", got, c.Region)
	}
}

func TestAPeerInAnotherJetStreamDomainGetsAnAPIPrefix(t *testing.T) {
	// Without it the source resolves against the local domain, finds no such
	// stream, and delivers nothing — indistinguishable from a quiet peer.
	c := cfg()
	c.PeerAPIPrefixes = map[string]string{"eu-west-1": "$JS.eu.API"}
	for _, src := range inboundConfig(c).Sources {
		if src.Name == "EVENTS_OUT_EU_WEST_1" {
			if src.External == nil || src.External.APIPrefix != "$JS.eu.API" {
				t.Fatalf("external config missing on a cross-domain source: %+v", src.External)
			}
			return
		}
	}
	t.Fatal("the configured peer was not sourced at all")
}

func TestTheImportConsumerCannotBeHandedThisRegionsOwnEvents(t *testing.T) {
	// The third independent guard, at the delivery layer.
	got := importConsumerConfig(cfg())
	for _, f := range got.FilterSubjects {
		if strings.HasPrefix(f, "evt.us-east-1.") {
			t.Fatalf("the import consumer filters on its own region: %q", f)
		}
	}
	if len(got.FilterSubjects) != 2 {
		t.Fatalf("filters = %v, want one per peer", got.FilterSubjects)
	}
	if got.MaxAckPending == 0 {
		t.Error("no flow control: a backlogged peer would hand this replica everything at once")
	}
	if got.AckPolicy != jetstream.AckExplicitPolicy {
		t.Error("events must not be acknowledged before they are in local Kafka")
	}
}
