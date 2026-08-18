package streams

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/task-board/region-bridge/internal/config"
	"github.com/task-board/region-bridge/internal/loop"
)

// The topology against a REAL JetStream server.
//
// The unit suite checks the configs this package builds; this checks what a
// server does with them — and the two are not the same question. Whether an
// inbound stream that sources a peer actually declines the local region's
// publishes, whether the dedupe window really drops a replayed message id, and
// whether a subject filter really excludes a region are all server semantics.
// A fake would encode this package's assumptions rather than test them, and
// those assumptions are the entire cycle-prevention argument.
//
// Both "regions" run on ONE server here, which exercises everything except the
// WAN transport: stream sourcing behaves identically whether the source stream
// is on this server or across a gateway. The gateway itself needs three nodes
// per region (see infra/nats/region-a.conf) and is out of scope for a test.
//
// Set NATS_TEST_URL to run. Skipped otherwise, so `go test ./...` stays green
// without a server:
//
//	docker run -d --rm -p 4232:4222 --name tb-test-nats nats:2.10-alpine -js
//	NATS_TEST_URL=nats://127.0.0.1:4232 go test ./internal/streams/ -run Integration -v
func testJS(t *testing.T) (jetstream.JetStream, *nats.Conn) {
	t.Helper()
	url := os.Getenv("NATS_TEST_URL")
	if url == "" {
		t.Skip("set NATS_TEST_URL to run the JetStream integration tests")
	}
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect %s: %v", url, err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		t.Fatalf("jetstream: %v", err)
	}
	t.Cleanup(nc.Close)
	return js, nc
}

// regions builds two configs that face each other, with names unique to the
// test so a shared server can run these in any order.
func regions(t *testing.T, tag string) (*config.Config, *config.Config) {
	t.Helper()
	base := func(region, peer string) *config.Config {
		return &config.Config{
			Region:         region,
			Peers:          []string{peer},
			Topics:         []string{"messaging.events.v1"},
			BatchSize:      16,
			MaxAckPending:  64,
			StreamMaxAge:   time.Hour,
			StreamMaxBytes: 64 << 20,
			StreamReplicas: 1,
			DedupeWindow:   time.Minute,
		}
	}
	return base("a"+tag, "b"+tag), base("b"+tag, "a"+tag)
}

func cleanup(t *testing.T, js jetstream.JetStream, names ...string) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, n := range names {
			_ = js.DeleteStream(ctx, n)
		}
	})
}

func TestIntegrationAnEventCrossesTheBoundaryExactlyOnce(t *testing.T) {
	js, _ := testJS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	a, b := regions(t, "one")
	cleanup(t, js, a.OutboundStream(), a.InboundStream(), b.OutboundStream(), b.InboundStream())

	// Both regions provisioned facing each other, which is the active-active
	// shape: each has an outbound stream and an inbound one sourcing the other.
	if _, err := Provision(ctx, js, a); err != nil {
		t.Fatalf("provision A: %v", err)
	}
	// Region B: sources A.
	consumer, err := Provision(ctx, js, b)
	if err != nil {
		t.Fatalf("provision B: %v", err)
	}

	// A publishes, exactly as the exporter does.
	msg := nats.NewMsg(a.SubjectFor("messaging.events.v1"))
	msg.Data = []byte(`{"type":"message.created"}`)
	msg.Header.Set(loop.HeaderOriginRegion, a.Region)
	msg.Header.Set(loop.HeaderHops, "1")
	msg.Header.Set(loop.HeaderKafkaTopic, "messaging.events.v1")
	msg.Header.Set(jetstream.MsgIDHeader, "evt-1")
	if _, err := js.PublishMsg(ctx, msg); err != nil {
		t.Fatalf("publish in A: %v", err)
	}

	// B receives it, with provenance intact — that header is what stops B's own
	// exporter sending it back.
	got := fetchOne(t, ctx, consumer)
	if origin := got.Headers().Get(loop.HeaderOriginRegion); origin != a.Region {
		t.Fatalf("origin arrived as %q, want %q — without it the event loops", origin, a.Region)
	}
	if err := got.Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}

	// THE assertion. A's inbound stream sources only B, and nothing in B
	// re-publishes A's event onto B's subject space — so the event A just sent
	// cannot come back to A. If this count is ever non-zero the mesh is a
	// cycle, and every region is about to see the same event forever.
	inA, err := js.Stream(ctx, a.InboundStream())
	if err != nil {
		t.Fatalf("A inbound stream: %v", err)
	}
	infoA, err := inA.Info(ctx)
	if err != nil {
		t.Fatalf("A inbound info: %v", err)
	}
	if infoA.State.Msgs != 0 {
		t.Fatalf("region A got %d of its own events back — the mesh is looping", infoA.State.Msgs)
	}
}

func TestIntegrationTheDedupeWindowAbsorbsAReplayedBatch(t *testing.T) {
	// The property the exporter's at-least-once retries depend on: a replay
	// republishes the same message ids, and the server drops them rather than
	// every peer region seeing the event twice.
	js, _ := testJS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	a, _ := regions(t, "dup")
	a.Peers = nil
	cleanup(t, js, a.OutboundStream())
	if _, err := Provision(ctx, js, a); err != nil {
		t.Fatalf("provision: %v", err)
	}

	publish := func(id string) {
		m := nats.NewMsg(a.SubjectFor("messaging.events.v1"))
		m.Data = []byte(`{}`)
		m.Header.Set(jetstream.MsgIDHeader, id)
		if _, err := js.PublishMsg(ctx, m); err != nil {
			t.Fatalf("publish %s: %v", id, err)
		}
	}
	publish("evt-dup")
	publish("evt-dup") // the retry
	publish("evt-other")

	st, err := js.Stream(ctx, a.OutboundStream())
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	info, err := st.Info(ctx)
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	if info.State.Msgs != 2 {
		t.Fatalf("stream holds %d messages, want 2 — the dedupe window is not doing its job",
			info.State.Msgs)
	}
}

func TestIntegrationARegionsOwnSubjectsCannotEnterItsInboundStream(t *testing.T) {
	// The structural half of loop prevention, verified against the server
	// rather than argued about: B's inbound stream has no subjects of its own,
	// so a publish on B's own subject cannot land in it.
	js, _ := testJS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	a, b := regions(t, "iso")
	cleanup(t, js, a.OutboundStream(), b.OutboundStream(), b.InboundStream())
	if _, err := Provision(ctx, js, a); err != nil {
		t.Fatalf("provision A: %v", err)
	}
	if _, err := Provision(ctx, js, b); err != nil {
		t.Fatalf("provision B: %v", err)
	}

	// B publishes its OWN event, the way B's exporter would.
	m := nats.NewMsg(b.SubjectFor("messaging.events.v1"))
	m.Data = []byte(`{}`)
	m.Header.Set(jetstream.MsgIDHeader, "b-local-1")
	if _, err := js.PublishMsg(ctx, m); err != nil {
		t.Fatalf("publish in B: %v", err)
	}

	// It belongs in B's OUTBOUND stream (for A to source) and must never appear
	// in B's inbound one, or B would import its own events and its exporter
	// would send them out again.
	in, err := js.Stream(ctx, b.InboundStream())
	if err != nil {
		t.Fatalf("inbound stream: %v", err)
	}
	info, err := in.Info(ctx)
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	if info.State.Msgs != 0 {
		t.Fatalf("B's inbound stream captured %d of B's own messages — that is the loop",
			info.State.Msgs)
	}
	if len(info.Config.Subjects) != 0 {
		t.Fatalf("B's inbound stream listens on %v; it must source only", info.Config.Subjects)
	}
}

func TestIntegrationProvisioningRefusesATopologyThatCouldLoop(t *testing.T) {
	// Somebody points a region's inbound stream at its own outbound stream —
	// two lines in a values file. The bridge must refuse to run rather than
	// replicate in circles.
	js, _ := testJS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	a, _ := regions(t, "cyc")
	cleanup(t, js, a.OutboundStream(), a.InboundStream())
	if _, err := Provision(ctx, js, a); err != nil {
		t.Fatalf("provision A: %v", err)
	}

	// Build the bad stream by hand, as a misconfigured deploy would.
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:    a.InboundStream(),
		Sources: []*jetstream.StreamSource{{Name: a.OutboundStream()}},
		// Same storage class as the stream Provision created: a storage change
		// is rejected outright, and this test is about the topology, not about
		// what else an update may not alter.
		Storage:  jetstream.FileStorage,
		MaxBytes: 1 << 20,
	}); err != nil {
		t.Fatalf("build the bad stream: %v", err)
	}

	st, err := js.Stream(ctx, a.InboundStream())
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	info, err := st.Info(ctx)
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	if err := AssertCannotLoop(&info.Config, a); err == nil {
		t.Fatal("a self-sourcing inbound stream was accepted")
	} else if !strings.Contains(err.Error(), "cycle") {
		t.Errorf("the refusal must name the consequence, got: %v", err)
	}
}

func fetchOne(t *testing.T, ctx context.Context, c jetstream.Consumer) jetstream.Msg {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		batch, err := c.Fetch(1, jetstream.FetchMaxWait(2*time.Second))
		if err != nil {
			t.Fatalf("fetch: %v", err)
		}
		for m := range batch.Messages() {
			return m
		}
		if err := batch.Error(); err != nil {
			t.Fatalf("batch: %v", err)
		}
	}
	t.Fatal("nothing was sourced across the boundary within the deadline")
	return nil
}
