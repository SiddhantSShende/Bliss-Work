package config

import (
	"strings"
	"testing"
)

// Config is where a cross-region deployment goes wrong, and where it is
// cheapest to catch: every case below is a live mesh replicating in circles, or
// a region quietly bridging nothing, if it is allowed through.

func withEnv(t *testing.T, kv map[string]string) *Config {
	t.Helper()
	base := map[string]string{
		"BRIDGE_REGION":       "us-east-1",
		"BRIDGE_PEER_REGIONS": "eu-west-1",
		"KAFKA_BROKERS":       "kafka:9092",
	}
	for k, v := range kv {
		base[k] = v
	}
	for k, v := range base {
		t.Setenv(k, v)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

func loadErr(t *testing.T, kv map[string]string) error {
	t.Helper()
	base := map[string]string{
		"BRIDGE_REGION":       "us-east-1",
		"BRIDGE_PEER_REGIONS": "eu-west-1",
		"KAFKA_BROKERS":       "kafka:9092",
	}
	for k, v := range kv {
		base[k] = v
	}
	for k, v := range base {
		t.Setenv(k, v)
	}
	_, err := Load()
	return err
}

func TestListingOurselvesAsAPeerIsRefused(t *testing.T) {
	// A cycle built entirely out of configuration: the region would source its
	// own outbound stream and re-import everything it just exported.
	err := loadErr(t, map[string]string{"BRIDGE_PEER_REGIONS": "eu-west-1,us-east-1"})
	if err == nil {
		t.Fatal("a region listed as its own peer was accepted")
	}
	if !strings.Contains(err.Error(), "cycle") {
		t.Errorf("the error must name the consequence, got: %v", err)
	}
}

func TestADuplicatePeerIsRefused(t *testing.T) {
	if err := loadErr(t, map[string]string{"BRIDGE_PEER_REGIONS": "eu-west-1,eu-west-1"}); err == nil {
		t.Fatal("a duplicated peer was accepted; it would be sourced twice")
	}
}

func TestARegionNameThatWouldBreakASubjectIsRefused(t *testing.T) {
	for _, bad := range []string{"", "us.east.1", "US-EAST-1", "us east"} {
		if err := loadErr(t, map[string]string{"BRIDGE_REGION": bad}); err == nil {
			t.Errorf("region %q was accepted; it is a NATS subject token", bad)
		}
	}
}

func TestBridgingTheDLQTopicIsRefused(t *testing.T) {
	// It would replicate every poison event to every region, and dead-letter it
	// again on arrival.
	err := loadErr(t, map[string]string{
		"BRIDGE_TOPICS":    "messaging.events.v1,region-bridge-dlq",
		"BRIDGE_DLQ_TOPIC": "region-bridge-dlq",
	})
	if err == nil {
		t.Fatal("the DLQ topic was accepted as a bridged topic")
	}
}

func TestAnUnboundedStreamIsRefused(t *testing.T) {
	// Zero means UNLIMITED to JetStream, not "default" — the kind of value
	// somebody sets to mean "don't worry about it".
	if err := loadErr(t, map[string]string{"BRIDGE_STREAM_MAX_GB": "0"}); err == nil {
		t.Error("BRIDGE_STREAM_MAX_GB=0 was accepted: the replication log would grow without bound")
	}
	if err := loadErr(t, map[string]string{"BRIDGE_DEDUPE_WINDOW": "0s"}); err == nil {
		t.Error("a zero dedupe window was accepted: every retry would double-deliver")
	}
}

func TestFlowControlMustNotStarveABatch(t *testing.T) {
	// A consumer that will not hand out a full batch stalls at the first fetch
	// and reads as a hang rather than as a misconfiguration.
	err := loadErr(t, map[string]string{
		"BRIDGE_BATCH_SIZE":      "512",
		"BRIDGE_MAX_ACK_PENDING": "100",
	})
	if err == nil {
		t.Fatal("MaxAckPending below BatchSize was accepted")
	}
}

func TestStreamNamesAndSubjectsAreDerivedConsistently(t *testing.T) {
	c := withEnv(t, nil)
	if got := c.OutboundStream(); got != "EVENTS_OUT_US_EAST_1" {
		t.Errorf("OutboundStream = %q", got)
	}
	if got := c.InboundStream(); got != "EVENTS_IN_US_EAST_1" {
		t.Errorf("InboundStream = %q", got)
	}
	// The subject carries the region as its own token so a peer's filter can
	// select it exactly.
	if got := c.SubjectFor("messaging.events.v1"); got != "evt.us-east-1.messaging.events.v1" {
		t.Errorf("SubjectFor = %q", got)
	}
}

func TestASingleRegionMeshIsLegal(t *testing.T) {
	// The first region of a new deployment runs with no peers until the second
	// is stood up; refusing that would make the rollout order load-bearing.
	c := withEnv(t, map[string]string{"BRIDGE_PEER_REGIONS": ""})
	if len(c.Peers) != 0 {
		t.Fatalf("peers = %v, want none", c.Peers)
	}
}

func TestRollbackSwitchesDefaultOnAndParseOff(t *testing.T) {
	c := withEnv(t, nil)
	if !c.ExportEnabled || !c.ImportEnabled {
		t.Fatal("both directions must default to on")
	}
	c = withEnv(t, map[string]string{"BRIDGE_EXPORT_ENABLED": "false", "BRIDGE_IMPORT_ENABLED": "0"})
	if c.ExportEnabled || c.ImportEnabled {
		t.Fatal("the rollback switches did not take effect")
	}
}

func TestPeerAPIPrefixesParse(t *testing.T) {
	c := withEnv(t, map[string]string{
		"BRIDGE_PEER_REGIONS":      "eu-west-1,ap-south-1",
		"BRIDGE_PEER_API_PREFIXES": "eu-west-1=$JS.eu.API, ap-south-1=$JS.ap.API",
	})
	if c.PeerAPIPrefixes["eu-west-1"] != "$JS.eu.API" || c.PeerAPIPrefixes["ap-south-1"] != "$JS.ap.API" {
		t.Fatalf("prefixes = %v", c.PeerAPIPrefixes)
	}
}
