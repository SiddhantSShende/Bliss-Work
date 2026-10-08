// Package config is the bridge's entire deployment contract: environment in,
// validated struct out, and a hard failure at startup for anything that would
// otherwise become a subtle runtime fault in a second region at 3am.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/task-board/region-bridge/internal/loop"
)

// Config is the resolved runtime configuration.
type Config struct {
	// Region is THIS deployment's region id. It is the origin stamp on every
	// event exported from here and one token of every subject, so it is
	// validated as strictly as a subject token (loop.ValidRegion).
	Region string
	// Peers are the other regions in the mesh. Each becomes one `source` on the
	// inbound stream. Empty is legal and means "nothing to import yet" — the
	// first region of a new mesh runs like that until the second is stood up.
	Peers []string

	KafkaBrokers []string
	// Topics bridged in both directions. Deliberately explicit rather than a
	// wildcard: a bridge that discovers topics would start replicating a new
	// one across the WAN the moment somebody created it locally.
	Topics []string
	// DLQTopic receives events that cannot be bridged and must not block the
	// stream behind them. Empty disables dead-lettering, which makes a poison
	// event block its partition — allowed, because for some deployments losing
	// ordering is worse than stalling, but it must be a choice. (That is the
	// exporter. The importer has nothing to block: with no DLQ it logs, counts
	// and terminates a poison event rather than recycling it.)
	DLQTopic string
	// KafkaGroupID is the consumer group the exporter joins. Distinct from
	// every application group so bridging cannot consume events away from the
	// services that need them.
	KafkaGroupID string

	NATSURL string
	// NATSCredentials is a path to a NATS credentials file (JWT/nkey). Empty
	// means an unauthenticated connection, which is for dev only.
	NATSCredentials string
	// NATSTLSCA/NATSTLSCert/NATSTLSKey configure TLS on the bridge's connection
	// to its LOCAL NATS cluster. This is a distinct concern from the
	// cluster/gateway TLS in infra/nats/*.conf, which secures NATS-server-to-
	// NATS-server traffic (intra-region routes and the cross-region gateway) —
	// that half is entirely server config and this process is not a party to
	// it. All three empty means an unencrypted client connection, which is what
	// the single-node dev server expects and is not fine anywhere else.
	NATSTLSCA   string
	NATSTLSCert string
	NATSTLSKey  string
	// PeerAPIPrefixes maps a peer region to the JetStream API prefix its
	// streams live behind, for the topologies where regions are separate
	// JetStream DOMAINS (leaf nodes) rather than one super-cluster account.
	// Absent means same-domain, which is the simpler and more common setup.
	//
	// It matters because getting it wrong is invisible: a source that resolves
	// against the local domain finds no such stream and simply delivers
	// nothing, which looks exactly like a peer with no traffic.
	PeerAPIPrefixes map[string]string

	// ExportEnabled / ImportEnabled are the rollback switches. Either can be
	// turned off independently and the bridge keeps its position — the Kafka
	// group offsets and the JetStream consumer state both persist — so
	// re-enabling catches up rather than starting from nothing.
	ExportEnabled bool
	ImportEnabled bool

	// BatchSize bounds one unit of work in both directions. It is also the
	// blast radius of a retry: a failed batch is replayed whole.
	BatchSize int
	// MaxAckPending bounds how many events the JetStream consumer will have
	// in flight before it stops handing out more. This is the flow-control
	// knob — it is what stops a slow local Kafka from being handed the entire
	// backlog of every peer at once.
	MaxAckPending int
	// PublishWindow bounds outstanding async publishes. Same purpose on the
	// export side: unbounded async publishing is how a stalled NATS server
	// turns into an out-of-memory kill rather than backpressure.
	PublishWindow int

	// StreamMaxAge / StreamMaxBytes bound the replication log. A bridge whose
	// stream grows without limit takes the region's JetStream store down with
	// it, which is a far worse outage than the replication lag it was avoiding.
	StreamMaxAge   time.Duration
	StreamMaxBytes int64
	// StreamReplicas is the JetStream replica count WITHIN a region (3 for a
	// production cluster, 1 for a single-node dev server).
	StreamReplicas int
	// DedupeWindow is how far back JetStream remembers a message id. It must
	// comfortably exceed the longest realistic redelivery gap, because it is
	// what makes the bridge's at-least-once retries harmless.
	DedupeWindow time.Duration

	// StallAfter is how long the bridge may make no progress WHILE WORK IS
	// PENDING before readiness fails. Progress with an empty backlog is not
	// staleness: an idle region must not be reported unhealthy.
	StallAfter time.Duration

	HTTPAddr string
}

// Load reads the environment and validates it. Every error is fatal by design:
// a bridge that starts with half its configuration missing replicates half its
// events, which is harder to notice than one that refuses to start.
func Load() (*Config, error) {
	var cfgErrs []string
	c := &Config{
		Region:          os.Getenv("BRIDGE_REGION"),
		Peers:           splitList(os.Getenv("BRIDGE_PEER_REGIONS")),
		KafkaBrokers:    splitList(envOr("KAFKA_BROKERS", "kafka:9092")),
		Topics:          splitList(envOr("BRIDGE_TOPICS", defaultTopics)),
		DLQTopic:        dlqTopicOr("BRIDGE_DLQ_TOPIC", "region-bridge-dlq"),
		KafkaGroupID:    envOr("BRIDGE_KAFKA_GROUP", "region-bridge"),
		NATSURL:         envOr("NATS_URL", "nats://nats:4222"),
		NATSCredentials: os.Getenv("NATS_CREDENTIALS"),
		NATSTLSCA:       os.Getenv("NATS_TLS_CA"),
		NATSTLSCert:     os.Getenv("NATS_TLS_CERT"),
		NATSTLSKey:      os.Getenv("NATS_TLS_KEY"),
		PeerAPIPrefixes: parseMap(os.Getenv("BRIDGE_PEER_API_PREFIXES")),
		ExportEnabled:   boolOr("BRIDGE_EXPORT_ENABLED", true, &cfgErrs),
		ImportEnabled:   boolOr("BRIDGE_IMPORT_ENABLED", true, &cfgErrs),
		BatchSize:       intOr("BRIDGE_BATCH_SIZE", 256, &cfgErrs),
		MaxAckPending:   intOr("BRIDGE_MAX_ACK_PENDING", 2048, &cfgErrs),
		PublishWindow:   intOr("BRIDGE_PUBLISH_WINDOW", 512, &cfgErrs),
		StreamMaxAge:    durOr("BRIDGE_STREAM_MAX_AGE", 24*time.Hour, &cfgErrs),
		StreamMaxBytes:  int64(intOr("BRIDGE_STREAM_MAX_GB", 32, &cfgErrs)) << 30,
		StreamReplicas:  intOr("BRIDGE_STREAM_REPLICAS", 3, &cfgErrs),
		DedupeWindow:    durOr("BRIDGE_DEDUPE_WINDOW", 2*time.Hour, &cfgErrs),
		StallAfter:      durOr("BRIDGE_STALL_AFTER", 2*time.Minute, &cfgErrs),
		HTTPAddr:        envOr("BRIDGE_HTTP_ADDR", ":8080"),
	}
	if len(cfgErrs) > 0 {
		return nil, fmt.Errorf("invalid config: %s", strings.Join(cfgErrs, "; "))
	}

	if !loop.ValidRegion(c.Region) {
		return nil, fmt.Errorf(
			"BRIDGE_REGION %q is not a valid region id: lowercase letters, digits and dashes only, "+
				"since it is one token of every NATS subject", c.Region)
	}
	seen := map[string]bool{c.Region: true}
	for _, p := range c.Peers {
		if !loop.ValidRegion(p) {
			return nil, fmt.Errorf("BRIDGE_PEER_REGIONS contains an invalid region id %q", p)
		}
		if seen[p] {
			// Listing ourselves would source our own outbound stream into our
			// inbound one — a cycle built entirely out of configuration, and
			// the exact mistake the runtime guard exists to survive. Refuse it
			// here as well, where the fix is obvious.
			return nil, fmt.Errorf(
				"BRIDGE_PEER_REGIONS lists %q twice, or lists this region — that builds a replication cycle", p)
		}
		seen[p] = true
	}
	if len(c.Topics) == 0 {
		return nil, fmt.Errorf("BRIDGE_TOPICS is empty: there is nothing to bridge")
	}
	if len(c.KafkaBrokers) == 0 {
		return nil, fmt.Errorf("KAFKA_BROKERS is empty")
	}
	for _, t := range c.Topics {
		if t == c.DLQTopic {
			// Bridging the dead-letter topic would replicate every poison event
			// to every region, and then dead-letter it there too.
			return nil, fmt.Errorf("BRIDGE_TOPICS must not contain the DLQ topic %q", t)
		}
	}
	if c.BatchSize < 1 || c.BatchSize > 10_000 {
		return nil, fmt.Errorf("BRIDGE_BATCH_SIZE %d is out of range (1..10000)", c.BatchSize)
	}
	if c.PublishWindow < 1 {
		return nil, fmt.Errorf("BRIDGE_PUBLISH_WINDOW must be at least 1")
	}
	if c.MaxAckPending < c.BatchSize {
		// A consumer that will not hand out a full batch stalls the importer at
		// the first fetch and looks like a hang rather than a misconfiguration.
		return nil, fmt.Errorf(
			"BRIDGE_MAX_ACK_PENDING (%d) must be at least BRIDGE_BATCH_SIZE (%d)", c.MaxAckPending, c.BatchSize)
	}
	if c.StreamReplicas < 1 || c.StreamReplicas > 5 {
		return nil, fmt.Errorf("BRIDGE_STREAM_REPLICAS %d is out of range (1..5)", c.StreamReplicas)
	}
	// Zero means UNLIMITED to JetStream, not "the default". Setting
	// BRIDGE_STREAM_MAX_GB=0 to mean "don't worry about it" would build a
	// replication log that grows until it takes the region's JetStream store
	// down — and with it everything else in that region using JetStream, which
	// is a far worse outage than the replication gap the bound protects against.
	if c.StreamMaxBytes <= 0 {
		return nil, fmt.Errorf("BRIDGE_STREAM_MAX_GB must be at least 1: zero means an unbounded stream")
	}
	if c.StreamMaxAge <= 0 {
		return nil, fmt.Errorf("BRIDGE_STREAM_MAX_AGE must be positive: zero means messages are never aged out")
	}
	// Without a dedupe window the exporter's at-least-once retries stop being
	// harmless and every retried batch is delivered twice in every peer region.
	if c.DedupeWindow <= 0 {
		return nil, fmt.Errorf("BRIDGE_DEDUPE_WINDOW must be positive: retries rely on it to be idempotent")
	}
	// A cert without its key (or vice versa) is not "half configured" — it is a
	// connection that nats.go will refuse to make, and refusing here says why in
	// one line instead of in whatever nats.Connect's wrapped error happens to be.
	if (c.NATSTLSCert == "") != (c.NATSTLSKey == "") {
		return nil, fmt.Errorf("NATS_TLS_CERT and NATS_TLS_KEY must be set together, or not at all")
	}
	return c, nil
}

// defaultTopics is the routing DIRECTORY ALONE — which org and which invite
// live at which site (docs/CROSS-REGION.md §9). It is the one topic every
// site genuinely needs from every other: org data is partitioned by site and
// never replicated, so without the directory reaching every site, a request
// that lands on the wrong one has no way to discover where its data actually
// lives.
//
// The platform's business topics (messaging.events.v1, task.events.v1,
// notification.events.v1, auth.events) must NOT be in this list. Each of
// those services' Kafka consumers has no concept of "site placement" — it
// processes whatever lands in its LOCAL topic — so bridging them would make
// every peer region's task-svc/messaging-svc/notification-svc/auth-svc
// materialize rows for orgs that were never placed there, permanently and
// with no cleanup path. §9's "never replicated" guarantee is enforced by
// this list staying short, not by anything downstream.
//
// Kept in one place so adding a topic is a config change in one file rather
// than a discovery rule nobody can audit.
const defaultTopics = "routing.events.v1"

// OutboundStream is the name of the stream this region publishes into.
func (c *Config) OutboundStream() string { return "EVENTS_OUT_" + Upper(c.Region) }

// InboundStream is the name of the stream this region imports from. It sources
// every peer's OUTBOUND stream and never its inbound one — sourcing an inbound
// stream is precisely how a mesh becomes a cycle.
func (c *Config) InboundStream() string { return "EVENTS_IN_" + Upper(c.Region) }

// SubjectPrefix is the root of every subject this region publishes.
func (c *Config) SubjectPrefix() string { return "evt." + c.Region }

// SubjectFor is where one Kafka topic's events are published.
func (c *Config) SubjectFor(topic string) string { return c.SubjectPrefix() + "." + topic }

// Upper normalizes a region name into the token used inside stream and
// subject names (uppercase, hyphens folded to underscores).
func Upper(s string) string { return strings.ToUpper(strings.ReplaceAll(s, "-", "_")) }

// parseMap reads a `k=v,k=v` list. A malformed entry is skipped rather than
// fatal: the field is optional, and the only deployments that set it are the
// ones that already know they need it.
func parseMap(v string) map[string]string {
	out := map[string]string{}
	for _, part := range splitList(v) {
		if k, val, ok := strings.Cut(part, "="); ok {
			if k, val = strings.TrimSpace(k), strings.TrimSpace(val); k != "" && val != "" {
				out[k] = val
			}
		}
	}
	return out
}

func splitList(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// dlqTopicOr resolves BRIDGE_DLQ_TOPIC specifically, distinguishing "unset"
// (use the default) from "explicitly set to empty" (dead-lettering
// intentionally disabled — see Config.DLQTopic). envOr cannot make that
// distinction: it treats every empty value, set or not, as unset, which is
// why an operator could never actually disable the DLQ before this.
func dlqTopicOr(k, def string) string {
	v, ok := os.LookupEnv(k)
	if !ok {
		return def
	}
	return strings.TrimSpace(v)
}

// intOr, boolOr and durOr all distinguish "unset" (use the default) from
// "explicitly set but unparseable" (append to errs, use the default only so
// construction can continue far enough to report every bad value at once —
// Load() below still refuses to start when errs is non-empty). A silent
// fallback here is exactly the failure mode Load's doc comment warns about:
// an operator's BRIDGE_EXPORT_ENABLED=no typo must not be indistinguishable
// from BRIDGE_EXPORT_ENABLED unset.
func intOr(k string, def int, errs *[]string) int {
	v, ok := os.LookupEnv(k)
	if !ok || strings.TrimSpace(v) == "" {
		return def
	}
	v = strings.TrimSpace(v)
	n, err := strconv.Atoi(v)
	if err != nil {
		*errs = append(*errs, fmt.Sprintf("%s=%q is not a valid integer", k, v))
		return def
	}
	return n
}

func boolOr(k string, def bool, errs *[]string) bool {
	v, ok := os.LookupEnv(k)
	if !ok || strings.TrimSpace(v) == "" {
		return def
	}
	v = strings.TrimSpace(v)
	b, err := strconv.ParseBool(v)
	if err != nil {
		*errs = append(*errs, fmt.Sprintf("%s=%q is not a valid bool", k, v))
		return def
	}
	return b
}

func durOr(k string, def time.Duration, errs *[]string) time.Duration {
	v, ok := os.LookupEnv(k)
	if !ok || strings.TrimSpace(v) == "" {
		return def
	}
	v = strings.TrimSpace(v)
	d, err := time.ParseDuration(v)
	if err != nil {
		*errs = append(*errs, fmt.Sprintf("%s=%q is not a valid duration", k, v))
		return def
	}
	if d <= 0 {
		*errs = append(*errs, fmt.Sprintf("%s=%q must be positive", k, v))
		return def
	}
	return d
}
