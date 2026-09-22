package middleware

// metrics.go: Phase 5 observability. Exposes Prometheus instrumentation for
// every HTTP request (except the /metrics scrape itself):
//
//   - http_requests_total          CounterVec   (method, path, status)
//   - http_request_duration_seconds HistogramVec (method, path) — DefBuckets
//
// The "path" label is the chi ROUTE PATTERN (e.g. /api/v1/channels/{id}/messages)
// not the raw URL, so UUIDs in the path don't explode label cardinality. When no
// pattern is available we fall back to "other".

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
)

var (
	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests, labeled by method, route pattern, and status code.",
		},
		[]string{"method", "path", "status"},
	)

	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request latency in seconds, labeled by method and route pattern.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
)

func init() {
	// Register once at package load. MustRegister panics on duplicate names,
	// which is the behaviour we want — a double-register is a programmer error.
	prometheus.MustRegister(httpRequestsTotal, httpRequestDuration)
}

// statusRecorder wraps http.ResponseWriter to capture the status code. HTTP
// responses that never call WriteHeader implicitly send 200, so we default to it.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (sr *statusRecorder) WriteHeader(code int) {
	if !sr.wroteHeader {
		sr.status = code
		sr.wroteHeader = true
	}
	sr.ResponseWriter.WriteHeader(code)
}

func (sr *statusRecorder) Write(b []byte) (int, error) {
	// A bare Write (no explicit WriteHeader) implies a 200; record that the
	// header was effectively written so a later observation reads 200, not 0.
	if !sr.wroteHeader {
		sr.wroteHeader = true
	}
	return sr.ResponseWriter.Write(b)
}

// methodLabel bounds the "method" label: Go accepts any token as an HTTP method,
// so passing r.Method through would let a client mint a fresh series per value
// (the path is already bounded by the route pattern below).
func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return method
	}
	return "OTHER"
}

// Metrics returns chi-compatible middleware that records request counts and
// latencies. It skips the /metrics endpoint entirely (Prometheus shouldn't
// scrape-measure itself). The route pattern is only known *after* chi routes the
// request, so this middleware must wrap the routes (placed via r.Use before the
// route definitions) — chi.RouteContext is populated by the time next returns.
func Metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never instrument the scrape endpoint itself.
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		// Resolve the low-cardinality route pattern after routing. Falls back to
		// "other" for unmatched routes (404s) so a flood of bogus URLs can't
		// create unbounded label series.
		path := "other"
		if rctx := chi.RouteContext(r.Context()); rctx != nil {
			if p := rctx.RoutePattern(); p != "" {
				path = p
			}
		}

		method := methodLabel(r.Method)
		httpRequestsTotal.WithLabelValues(method, path, strconv.Itoa(rec.status)).Inc()
		httpRequestDuration.WithLabelValues(method, path).Observe(time.Since(start).Seconds())
	})
}
