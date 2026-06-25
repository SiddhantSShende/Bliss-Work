package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	dto "github.com/prometheus/client_model/go"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// counterFor reads the current value of http_requests_total for one label set.
// The metric is process-global and registered once in init(), so tests must use
// disjoint label values (distinct paths/statuses) to stay independent rather
// than resetting shared state.
func counterFor(t *testing.T, method, path, status string) float64 {
	t.Helper()
	m, err := httpRequestsTotal.GetMetricWithLabelValues(method, path, status)
	if err != nil {
		t.Fatalf("GetMetricWithLabelValues: %v", err)
	}
	return testutil.ToFloat64(m)
}

// histCountFor reports how many observations landed in the duration histogram
// for a (method, path) pair by reading its _count sample from the metric proto.
// GetMetricWithLabelValues lazily creates the series, but a freshly created one
// has SampleCount 0, so this still distinguishes "observed" from "untouched".
func histCountFor(t *testing.T, method, path string) uint64 {
	t.Helper()
	m, err := httpRequestDuration.GetMetricWithLabelValues(method, path)
	if err != nil {
		t.Fatalf("GetMetricWithLabelValues: %v", err)
	}
	var pb dto.Metric
	if err := m.(interface{ Write(*dto.Metric) error }).Write(&pb); err != nil {
		t.Fatalf("write metric proto: %v", err)
	}
	if pb.Histogram == nil {
		return 0
	}
	return pb.Histogram.GetSampleCount()
}

// newRouter wires Metrics ahead of the routes so chi has populated the route
// context (and thus RoutePattern) by the time Metrics reads it.
func newRouter(pattern string, h http.HandlerFunc) *chi.Mux {
	r := chi.NewRouter()
	r.Use(Metrics)
	r.Method(http.MethodGet, pattern, h)
	r.Method(http.MethodPost, pattern, h)
	return r
}

// Metrics must record a count and a latency observation, and the "path" label
// must be the chi ROUTE PATTERN, not the concrete URL (so a UUID in the URL
// doesn't explode label cardinality).
func TestMetrics_RecordsCountAndRoutePattern(t *testing.T) {
	const pattern = "/api/v1/conv/{id}/messages"
	r := newRouter(pattern, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	before := counterFor(t, http.MethodGet, pattern, "200")

	// Concrete URL carries a UUID; the recorded label must collapse to the pattern.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/conv/123e4567-e89b-12d3-a456-426614174000/messages", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	after := counterFor(t, http.MethodGet, pattern, "200")
	if after-before != 1 {
		t.Errorf("http_requests_total{path=pattern} delta = %v, want 1", after-before)
	}

	// The raw-URL label must NOT exist — only the pattern is recorded.
	raw := counterFor(t, http.MethodGet, "/api/v1/conv/123e4567-e89b-12d3-a456-426614174000/messages", "200")
	if raw != 0 {
		t.Errorf("raw URL was used as a label (cardinality leak): got %v", raw)
	}

	// A latency observation must have been recorded for this (method, path).
	if c := histCountFor(t, http.MethodGet, pattern); c == 0 {
		t.Errorf("no duration histogram observation recorded for %s", pattern)
	}
}

// The recorded status label must reflect the handler's actual status code, even
// when it differs from the 200 default, because statusRecorder captures it.
func TestMetrics_CapturesNonDefaultStatus(t *testing.T) {
	const pattern = "/api/v1/teapot"
	r := newRouter(pattern, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})

	before := counterFor(t, http.MethodGet, pattern, "418")

	req := httptest.NewRequest(http.MethodGet, pattern, nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	after := counterFor(t, http.MethodGet, pattern, "418")
	if after-before != 1 {
		t.Errorf("counter delta for status 418 = %v, want 1", after-before)
	}
	// And it must NOT have been booked as a 200.
	if got := counterFor(t, http.MethodGet, pattern, "200"); got != 0 {
		t.Errorf("request booked as 200 instead of 418: got %v", got)
	}
}

// A handler that writes a body without calling WriteHeader implies a 200; the
// recorder must book that as "200", not "0".
func TestMetrics_BareWriteCountsAs200(t *testing.T) {
	const pattern = "/api/v1/barewrite"
	r := newRouter(pattern, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	before := counterFor(t, http.MethodGet, pattern, "200")
	req := httptest.NewRequest(http.MethodGet, pattern, nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	after := counterFor(t, http.MethodGet, pattern, "200")

	if after-before != 1 {
		t.Errorf("bare-Write request not booked as 200: delta = %v", after-before)
	}
	if got := counterFor(t, http.MethodGet, pattern, "0"); got != 0 {
		t.Errorf("request booked with status 0: got %v", got)
	}
}

// The /metrics scrape endpoint must be excluded entirely — Prometheus shouldn't
// measure its own scrape. Wrap Metrics directly (no chi) and assert nothing was
// recorded under the "/metrics" or "other" path for this request.
func TestMetrics_SelfExcludesMetricsEndpoint(t *testing.T) {
	innerCalled := false
	h := Metrics(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	// Baselines for the two label sets the endpoint could plausibly land in.
	beforeMetricsPath := counterFor(t, http.MethodGet, "/metrics", "200")
	beforeOther := counterFor(t, http.MethodGet, "other", "200")

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if !innerCalled {
		t.Fatal("next handler not called for /metrics")
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if d := counterFor(t, http.MethodGet, "/metrics", "200") - beforeMetricsPath; d != 0 {
		t.Errorf("/metrics request was instrumented under /metrics label: delta = %v", d)
	}
	if d := counterFor(t, http.MethodGet, "other", "200") - beforeOther; d != 0 {
		t.Errorf("/metrics request was instrumented under other label: delta = %v", d)
	}
}

// An unmatched route (404, no chi pattern) must fall back to the low-cardinality
// "other" label so a flood of bogus URLs can't create unbounded series.
func TestMetrics_UnmatchedRouteUsesOtherLabel(t *testing.T) {
	r := chi.NewRouter()
	r.Use(Metrics)
	r.Get("/known", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	before := counterFor(t, http.MethodGet, "other", "404")

	req := httptest.NewRequest(http.MethodGet, "/this/does/not/exist", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
	if d := counterFor(t, http.MethodGet, "other", "404") - before; d != 1 {
		t.Errorf("unmatched route delta on 'other' label = %v, want 1", d)
	}
}
