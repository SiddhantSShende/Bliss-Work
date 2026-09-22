package server

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// seriesOf counts the label sets a collector currently holds.
func seriesOf(t *testing.T, name string) int {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() == name {
			return len(f.GetMetric())
		}
	}
	return 0
}

func labelValues(t *testing.T, name, label string) map[string]bool {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	out := map[string]bool{}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == label {
					out[l.GetValue()] = true
				}
			}
		}
	}
	return out
}

func instrumentedMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	return metrics(mux)
}

// A scanner (or anyone) can send an unbounded number of distinct paths and methods.
// Each used to become its own counter series and its own duration histogram in this
// process, for as long as it ran.
func TestMetrics_ClientChosenPathsAndMethodsDoNotMintSeries(t *testing.T) {
	h := instrumentedMux()
	before := seriesOf(t, "http_requests_total")

	for i := 0; i < 500; i++ {
		req := httptest.NewRequest("BREW"+strconv.Itoa(i%50), "/scan/"+strconv.Itoa(i), nil)
		h.ServeHTTP(httptest.NewRecorder(), req)
	}

	if grew := seriesOf(t, "http_requests_total") - before; grew > 2 {
		t.Fatalf("500 distinct unmatched requests created %d new series, want at most 2 (one 404 series per bounded method)", grew)
	}
	for _, name := range []string{"http_requests_total", "http_request_duration_seconds"} {
		if labelValues(t, name, "path")["/scan/7"] {
			t.Errorf("%s carries a client-chosen path as a label value", name)
		}
	}
}

func TestMetrics_RegisteredRoutesKeepTheirOwnPathLabel(t *testing.T) {
	h := instrumentedMux()

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/nope", nil))

	paths := labelValues(t, "http_requests_total", "path")
	if !paths["/healthz"] {
		t.Errorf("a registered route lost its path label (%d label values in total)", len(paths))
	}
	if !paths[unmatchedPath] {
		t.Errorf("an unrouted request was not counted under %q (%d label values in total)", unmatchedPath, len(paths))
	}
}
