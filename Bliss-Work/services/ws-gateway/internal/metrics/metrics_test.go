package metrics

import (
	"sort"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// Metric names are a PUBLIC contract, not an implementation detail.
//
// infra/observability/prometheus/rules/gateway.yml queries every name below by
// hand, and Prometheus does not validate that a rule's query matches anything.
// Rename a metric here and the recording rules quietly evaluate to nothing, the
// alerts quietly stop firing, and the first sign of it is an incident nobody
// was paged for. This test is the thing that turns that into a build failure.
//
// If you are here because this test failed: renaming is fine, but update the
// rules file in the same change.
func TestExportedMetricNamesMatchTheAlertingRules(t *testing.T) {
	// Every name referenced by rules/gateway.yml.
	want := []string{
		"ws_connections_rejected_total",
		"ws_connections_shed_total",
		"ws_fanout_discarded_total",
		"ws_fanout_outbox_writes_total",
		"ws_fanout_recipients_total",
		"ws_node_fanout_recipients_total",
		"ws_node_fanout_requests_total",
		"ws_node_fanout_unroutable_total",
		"ws_redis_op_duration_seconds",
		"ws_redis_ops_total",
		"ws_route_cache_total",
		"ws_turn_credentials_total",
	}

	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	got := make(map[string]bool, len(families))
	for _, f := range families {
		got[f.GetName()] = true
	}

	var missing []string
	for _, name := range want {
		// Histograms are gathered under their base name; the _bucket/_sum/_count
		// series the rules query are derived from it by Prometheus.
		if !got[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("metric(s) not exported: %s\n\n"+
			"infra/observability/prometheus/rules/gateway.yml queries these by name. "+
			"A rule that matches nothing does not error — it silently evaluates to "+
			"empty, so the alert simply never fires. Update the rules file alongside "+
			"any rename here.", strings.Join(missing, ", "))
	}
}

// Metrics that exist but have never been touched are absent from a scrape, so a
// dashboard panel reads "no data" — which is ambiguous in the worst way: is
// nothing happening, or is nothing reporting? Pre-creating the label sets makes
// a quiet gateway show an honest zero.
func TestLabelCombinationsArePreCreated(t *testing.T) {
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	series := map[string]int{}
	for _, f := range families {
		series[f.GetName()] = len(f.GetMetric())
	}

	cases := []struct {
		name string
		want int
	}{
		{"ws_connections_rejected_total", 2},   // node, per_user
		{"ws_fanout_outbox_writes_total", 2},   // ok, error
		{"ws_redis_ops_total", 6},              // 3 purposes × {ok, error}
		{"ws_turn_credentials_total", 2},       // offered, unavailable
		{"ws_node_fanout_requests_total", 2},   // ok, error
		{"ws_node_fanout_recipients_total", 2}, // local, remote
		{"ws_route_cache_total", 4},            // 2 caches × {hit, miss}
	}
	for _, c := range cases {
		if got := series[c.name]; got < c.want {
			t.Errorf("%s exports %d series before any traffic, want at least %d — "+
				"a dashboard shows 'no data' rather than zero for the missing ones",
				c.name, got, c.want)
		}
	}
}

// The purpose labels are what make the Redis metrics actionable: one server
// carries presence heartbeats, replay buffers and the node registry, and sizing
// or sharding it means knowing which of the three is the load. They are
// constants so a typo at a call site is a compile error rather than a silently
// separate time series.
func TestRedisPurposesAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range []string{PurposePresence, PurposeOutbox, PurposeNodes} {
		if p == "" {
			t.Error("an empty purpose would merge into one unlabelled series")
		}
		if seen[p] {
			t.Errorf("duplicate purpose %q — two call sites would share a series", p)
		}
		seen[p] = true
	}
}

// Result must map to exactly two values, because every `result` label in the
// rules file is matched against one of them.
func TestResultMapsErrorsToTwoValues(t *testing.T) {
	if got := Result(nil); got != "ok" {
		t.Errorf(`Result(nil) = %q, want "ok"`, got)
	}
	if got := Result(errStub{}); got != "error" {
		t.Errorf(`Result(err) = %q, want "error"`, got)
	}
}

type errStub struct{}

func (errStub) Error() string { return "stub" }
