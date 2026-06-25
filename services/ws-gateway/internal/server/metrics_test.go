package server

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// counterValue reads the current value of http_requests_total for one label set.
func counterValue(t *testing.T, method, path, status string) float64 {
	t.Helper()
	m := &dto.Metric{}
	c, err := httpRequestsTotal.GetMetricWithLabelValues(method, path, status)
	if err != nil {
		t.Fatalf("GetMetricWithLabelValues: %v", err)
	}
	if err := c.Write(m); err != nil {
		t.Fatalf("counter Write: %v", err)
	}
	return m.GetCounter().GetValue()
}

// durationSampleCount returns the histogram sample count for (method, path), or
// -1 if no series exists for that label pair (i.e. the route was never timed).
func durationSampleCount(t *testing.T, method, path string) int64 {
	t.Helper()
	ch := make(chan prometheus.Metric, 64)
	httpRequestDuration.Collect(ch)
	close(ch)
	for metric := range ch {
		m := &dto.Metric{}
		if err := metric.Write(m); err != nil {
			t.Fatalf("histogram Write: %v", err)
		}
		var gotMethod, gotPath string
		for _, l := range m.GetLabel() {
			switch l.GetName() {
			case "method":
				gotMethod = l.GetValue()
			case "path":
				gotPath = l.GetValue()
			}
		}
		if gotMethod == method && gotPath == path {
			return int64(m.GetHistogram().GetSampleCount())
		}
	}
	return -1
}

func TestMetricsMiddleware_CountsAndTimes(t *testing.T) {
	tests := []struct {
		name          string
		path          string
		handlerStatus int
		wantCounted   bool // appears in http_requests_total
		wantTimed     bool // appears in http_request_duration_seconds
	}{
		{
			name:          "ws is counted but not timed",
			path:          wsPath,
			handlerStatus: http.StatusOK,
			wantCounted:   true,
			wantTimed:     false,
		},
		{
			name:          "normal route is counted and timed",
			path:          "/presence",
			handlerStatus: http.StatusOK,
			wantCounted:   true,
			wantTimed:     true,
		},
		{
			name:          "metrics scrape is neither counted nor timed",
			path:          metricsPath,
			handlerStatus: http.StatusOK,
			wantCounted:   false,
			wantTimed:     false,
		},
		{
			name:          "non-200 status is recorded on the counter label",
			path:          "/readyz",
			handlerStatus: http.StatusServiceUnavailable,
			wantCounted:   true,
			wantTimed:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status := strconv.Itoa(tc.handlerStatus)
			before := counterValue(t, http.MethodGet, tc.path, status)
			beforeSamples := durationSampleCount(t, http.MethodGet, tc.path)

			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.handlerStatus)
				_, _ = w.Write([]byte("body"))
			})
			h := metrics(next)

			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tc.handlerStatus {
				t.Fatalf("status passed through = %d, want %d", rec.Code, tc.handlerStatus)
			}

			after := counterValue(t, http.MethodGet, tc.path, status)
			if tc.wantCounted {
				if after != before+1 {
					t.Fatalf("counter delta = %v, want +1 (before=%v after=%v)", after-before, before, after)
				}
			} else {
				if after != before {
					t.Fatalf("counter changed for un-instrumented path: before=%v after=%v", before, after)
				}
			}

			afterSamples := durationSampleCount(t, http.MethodGet, tc.path)
			if tc.wantTimed {
				if afterSamples != beforeSamples+1 && !(beforeSamples == -1 && afterSamples == 1) {
					t.Fatalf("histogram sample delta wrong: before=%d after=%d", beforeSamples, afterSamples)
				}
			} else {
				if afterSamples != beforeSamples {
					t.Fatalf("path %q should not be timed: before=%d after=%d", tc.path, beforeSamples, afterSamples)
				}
			}
		})
	}
}

// hijackRecorder is a ResponseWriter that also satisfies http.Hijacker, used to
// prove statusRecorder.Unwrap exposes the wrapped writer so the websocket
// hijack chain (http.ResponseController) can reach Hijacker through it.
type hijackRecorder struct {
	*httptest.ResponseRecorder
	hijacked bool
}

func (h *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	return nil, nil, nil
}

func TestStatusRecorder_UnwrapReachesHijacker(t *testing.T) {
	base := &hijackRecorder{ResponseRecorder: httptest.NewRecorder()}
	rec := &statusRecorder{ResponseWriter: base, status: http.StatusOK}

	// Direct Unwrap must return the exact wrapped writer.
	if rec.Unwrap() != base {
		t.Fatal("Unwrap did not return the underlying ResponseWriter")
	}

	// http.ResponseController walks the Unwrap chain to find the Hijacker that
	// statusRecorder itself does not implement.
	rc := http.NewResponseController(rec)
	if _, _, err := rc.Hijack(); err != nil {
		t.Fatalf("Hijack through Unwrap chain failed: %v", err)
	}
	if !base.hijacked {
		t.Fatal("expected the underlying Hijacker to be invoked via Unwrap")
	}
}

func TestStatusRecorder_DefaultsAndCapture(t *testing.T) {
	tests := []struct {
		name       string
		write      func(r *statusRecorder)
		wantStatus int
	}{
		{
			name:       "no WriteHeader implies recorded 200 default",
			write:      func(r *statusRecorder) { _, _ = r.Write([]byte("hi")) },
			wantStatus: http.StatusOK,
		},
		{
			name:       "explicit WriteHeader is captured",
			write:      func(r *statusRecorder) { r.WriteHeader(http.StatusTeapot) },
			wantStatus: http.StatusTeapot,
		},
		{
			name: "first WriteHeader wins, later ones ignored",
			write: func(r *statusRecorder) {
				r.WriteHeader(http.StatusNotFound)
				r.WriteHeader(http.StatusOK)
			},
			wantStatus: http.StatusNotFound,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := &statusRecorder{ResponseWriter: httptest.NewRecorder(), status: http.StatusOK}
			tc.write(rec)
			if rec.status != tc.wantStatus {
				t.Fatalf("recorded status = %d, want %d", rec.status, tc.wantStatus)
			}
		})
	}
}
