// Package streams builds the cross-region JetStream topology and refuses to
// start in one that could loop.
//
// ── The shape ────────────────────────────────────────────────────────────────
//
//	region A                                     region B
//	EVENTS_OUT_A   subjects: evt.a.>             EVENTS_OUT_B   subjects: evt.b.>
//	     │  (only A's exporter publishes here)        │
//	     └───────────────► EVENTS_IN_B ◄──────────────┘  sources: EVENTS_OUT_A, …
//	                       (no subjects of its own)
//
// Two properties do the work, and both are structural rather than procedural:
//
//  1. An outbound stream captures ONLY its own region's subject space. Nothing
//     in this system publishes another region's subject, so a foreign event can
//     never enter A's outbound log — and the outbound log is the only thing
//     peers source.
//
//  2. An inbound stream has NO subjects. It receives exclusively what it
//     sources. Give it `evt.>` "for convenience" and it captures the local
//     region's own publishes too, which the importer then writes back into
//     local Kafka — a loop built out of one config field.
//
// Property 2 is asserted after provisioning rather than assumed, because a
// stream that already exists with the wrong config is exactly the case a fresh
// deploy walks into.
package streams

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/task-board/region-bridge/internal/config"
)

// ImportDurable is the shared durable consumer name. Every replica in a region
// binds to the SAME durable, which is what makes them a work-sharing group
// rather than N copies of the whole stream — the horizontal-scale story.
func ImportDurable(region string) string { return "bridge-import-" + region }

// maxDeliver bounds JetStream's own redelivery. Set well above the bridge's own
// dead-letter threshold on purpose: the bridge decides when an event is poison
// and records WHY, and a server-side limit that fired first would silently stop
// delivering with nothing written down anywhere.
const maxDeliver = 64

// Provision creates or updates every stream and consumer this region needs, and
// returns the inbound consumer the importer pulls from.
//
// Idempotent: safe to run on every pod start, which is what makes a rollout of
// N replicas a no-op rather than a race.
func Provision(ctx context.Context, js jetstream.JetStream, cfg *config.Config) (jetstream.Consumer, error) {
	if _, err := js.CreateOrUpdateStream(ctx, outboundConfig(cfg)); err != nil {
		return nil, fmt.Errorf("outbound stream %s: %w", cfg.OutboundStream(), storageHint(err, cfg))
	}

	// No peers yet: the first region of a mesh, or a deliberate single-region
	// deployment. There is nothing to source and therefore nothing to import,
	// and building an empty sourcing stream would only create something to go
	// wrong later.
	if len(cfg.Peers) == 0 {
		return nil, nil
	}

	in, err := js.CreateOrUpdateStream(ctx, inboundConfig(cfg))
	if err != nil {
		return nil, fmt.Errorf("inbound stream %s: %w", cfg.InboundStream(), storageHint(err, cfg))
	}
	// Read back rather than trust: CreateOrUpdateStream is expected to have
	// corrected a wrong pre-existing config, and this checks that it did.
	info, err := in.Info(ctx)
	if err != nil {
		return nil, fmt.Errorf("read back %s: %w", cfg.InboundStream(), err)
	}
	if err := AssertCannotLoop(&info.Config, cfg); err != nil {
		return nil, err
	}

	cons, err := in.CreateOrUpdateConsumer(ctx, importConsumerConfig(cfg))
	if err != nil {
		return nil, fmt.Errorf("import consumer: %w", err)
	}
	return cons, nil
}

// storageHint names the two numbers that have to agree when JetStream refuses a
// stream for space.
//
// The server's error says only "insufficient storage resources available",
// which is true and unactionable: the reader has no way to know whether to
// shrink the stream or grow the server. Both numbers are named here because
// getting this wrong is a service that will not start, and the first place
// anyone looks is this log line.
func storageHint(err error, cfg *config.Config) error {
	if err == nil || !strings.Contains(err.Error(), "insufficient storage") {
		return err
	}
	return fmt.Errorf(
		"%w — this stream asks for %d GB (BRIDGE_STREAM_MAX_GB) × %d replicas (BRIDGE_STREAM_REPLICAS); "+
			"either lower them or raise the server's jetstream.max_file_store",
		err, cfg.StreamMaxBytes>>30, cfg.StreamReplicas)
}

func outboundConfig(cfg *config.Config) jetstream.StreamConfig {
	return jetstream.StreamConfig{
		Name:        cfg.OutboundStream(),
		Description: "Events produced in " + cfg.Region + ", for peer regions to source.",
		// This region's subject space and nothing else. The narrowness IS the
		// loop prevention — see the package comment.
		Subjects:  []string{cfg.SubjectPrefix() + ".>"},
		Retention: jetstream.LimitsPolicy,
		Storage:   jetstream.FileStorage,
		Replicas:  cfg.StreamReplicas,
		// Pins every replica to THIS region's own cluster. Without it, a gateway
		// connecting two regions' clusters forms one JetStream supercluster (a
		// gateway is a mesh at the messaging layer, not a boundary at the
		// placement layer — confirmed directly: two 3-node regions gatewayed
		// together report cluster_size 6, one merged meta-cluster, not two), and
		// the default placement algorithm may refuse a stream outright ("no
		// suitable peers for placement") rather than guess which region a
		// replica belongs in. infra/nats/region-a.conf and region-b.conf
		// deliberately do NOT set `jetstream.domain` for this reason: distinct
		// domains are how JetStream is isolated over LEAF NODE connections, not
		// gateways — mixing the two is the inconsistency that produced the
		// placement failure in the first place.
		Placement: &jetstream.Placement{Cluster: cfg.Region},
		// Bounded on both axes. An unbounded replication log fills the region's
		// JetStream store and takes down everything else using it — a much
		// worse outage than the replication gap it was avoiding. Discard old:
		// a peer that has been down longer than the window has to be
		// re-seeded, and saying so loudly beats wedging the local region.
		MaxAge:   cfg.StreamMaxAge,
		MaxBytes: cfg.StreamMaxBytes,
		Discard:  jetstream.DiscardOld,
		// The dedupe window is what makes the exporter's at-least-once retries
		// harmless: a replayed batch republishes the same Nats-Msg-Id and the
		// server drops the duplicate instead of the peer seeing the event twice.
		Duplicates:  cfg.DedupeWindow,
		Compression: jetstream.S2Compression,
	}
}

func inboundConfig(cfg *config.Config) jetstream.StreamConfig {
	sources := make([]*jetstream.StreamSource, 0, len(cfg.Peers))
	for _, peer := range cfg.Peers {
		src := &jetstream.StreamSource{
			Name: "EVENTS_OUT_" + config.Upper(peer),
			// Belt and braces: a peer's outbound stream cannot contain another
			// region's subjects, so this filter is redundant today. It stops
			// being redundant the moment somebody widens that stream's subject
			// list, which is the kind of change that looks harmless.
			FilterSubject: "evt." + peer + ".>",
		}
		if prefix := cfg.PeerAPIPrefixes[peer]; prefix != "" {
			// Different JetStream domain (leaf node / separate account). Without
			// this the source resolves against the local domain and silently
			// finds nothing, which looks exactly like a peer with no traffic.
			src.External = &jetstream.ExternalStream{APIPrefix: prefix}
		}
		sources = append(sources, src)
	}
	return jetstream.StreamConfig{
		Name:        cfg.InboundStream(),
		Description: "Events sourced from peer regions, for import into local Kafka.",
		// DELIBERATELY EMPTY. See the package comment: subjects here would make
		// this stream capture the local region's own publishes and loop them
		// back through the importer.
		Subjects:  nil,
		Sources:   sources,
		Retention: jetstream.LimitsPolicy,
		Storage:   jetstream.FileStorage,
		Replicas:  cfg.StreamReplicas,
		// Same reasoning as outboundConfig's Placement — this region's inbound
		// stream replicates within this region's own cluster too, even though
		// its DATA is sourced across the gateway from peers.
		Placement:   &jetstream.Placement{Cluster: cfg.Region},
		MaxAge:      cfg.StreamMaxAge,
		MaxBytes:    cfg.StreamMaxBytes,
		Discard:     jetstream.DiscardOld,
		Compression: jetstream.S2Compression,
	}
}

func importConsumerConfig(cfg *config.Config) jetstream.ConsumerConfig {
	filters := make([]string, 0, len(cfg.Peers))
	for _, peer := range cfg.Peers {
		filters = append(filters, "evt."+peer+".>")
	}
	return jetstream.ConsumerConfig{
		Durable:     ImportDurable(cfg.Region),
		Description: "region-bridge import into local Kafka",
		AckPolicy:   jetstream.AckExplicitPolicy,
		// A third independent guard, at the delivery layer: even if the inbound
		// stream somehow held this region's own events, they would not be
		// handed to the importer.
		FilterSubjects: filters,
		// Flow control. Without it a peer that has been queuing for an hour
		// hands this replica its entire backlog at once, and the memory that
		// takes is the memory the local Kafka producer needed.
		MaxAckPending: cfg.MaxAckPending,
		MaxDeliver:    maxDeliver,
		// Redelivery has to outlast a Kafka leader election, or a batch that
		// would have succeeded on its own is redelivered on top of itself.
		AckWait: 2 * time.Minute,
		// Server-side backoff for the first few redeliveries, so a NAK'd batch
		// does not come straight back while the cause is still there.
		BackOff:       []time.Duration{time.Second, 5 * time.Second, 15 * time.Second, time.Minute},
		DeliverPolicy: jetstream.DeliverAllPolicy,
		ReplayPolicy:  jetstream.ReplayInstantPolicy,
	}
}

// AssertCannotLoop refuses a topology in which replicated events could come
// back round.
//
// Pure, and exported, so the three ways a mesh becomes a cycle can be tested
// without standing up two NATS clusters — which is the only other way to find
// out, and it is not a way anyone finds out in time. Some stream fields cannot
// be updated in place, so "we asked for the right config" is not the same as
// "the stream has it", and the failure mode of assuming otherwise is a silent
// replication cycle rather than an error.
func AssertCannotLoop(got *jetstream.StreamConfig, cfg *config.Config) error {
	if len(got.Subjects) > 0 {
		return fmt.Errorf(
			"inbound stream %s has subjects %v: it must source only, or it captures this region's "+
				"own publishes and the importer writes them straight back into local Kafka",
			cfg.InboundStream(), got.Subjects)
	}
	own := "EVENTS_OUT_" + config.Upper(cfg.Region)
	for _, src := range got.Sources {
		if src.Name == own {
			return fmt.Errorf(
				"inbound stream %s sources this region's own outbound stream %s: that is a replication cycle",
				cfg.InboundStream(), own)
		}
		if strings.HasPrefix(src.Name, "EVENTS_IN_") {
			return fmt.Errorf(
				"inbound stream %s sources another region's INBOUND stream %s: source outbound streams only, "+
					"or events are re-replicated hop after hop", cfg.InboundStream(), src.Name)
		}
	}
	return nil
}
