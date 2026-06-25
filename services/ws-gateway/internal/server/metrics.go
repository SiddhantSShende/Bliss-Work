package server

import (
	"net/http"
	"strconv"

	"github.com/prometheus/client_golang/prometheus"
)

// metricsPath is the scrape endpoint. It is excluded from instrumentation so a
// scrape does not inflate its own counters/histograms.
const metricsPath = "/metrics"

// wsPath is the long-lived websocket route. It is counted in
// httpRequestsTotal but excluded from the duration histogram: a socket that
// stays open for minutes/hours would otherwise dominate the buckets and make
// the latency signal meaningless.
const wsPath = "/ws"

var (
	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests by method, path and status.",
		},
		[]string{"method", "path", "status"},
	)

	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request latency in seconds by method and path.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
)

func init() {
	prometheus.MustRegister(httpRequestsTotal, httpRequestDuration)
}

// statusRecorder wraps http.ResponseWriter to capture the status code written
// by the handler. It defaults to 200 because a handler that writes a body
// without calling WriteHeader implicitly returns 200.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		// First write implies a 200 if WriteHeader was never called.
		r.wroteHeader = true
	}
	return r.ResponseWriter.Write(b)
}

// Unwrap exposes the underlying ResponseWriter so http.ResponseController and
// the coder/websocket hijack path can reach interfaces (http.Hijacker,
// http.Flusher) that statusRecorder does not implement itself. Without this the
// /ws upgrade would fail to find the Hijacker through the wrapper.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// metrics records request counts and durations for every route except
// /metrics itself. For ServeMux services the registered paths are static
// (/healthz, /readyz, /ws, /presence) so r.URL.Path is already low-cardinality
// and safe to use as the "path" label without UUID explosion.
func metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == metricsPath {
			// Never instrument the scrape endpoint.
			next.ServeHTTP(w, r)
			return
		}

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		// Only time non-websocket routes. A long-lived /ws connection would
		// skew the latency histogram, so it is counted but not observed.
		if path == wsPath {
			next.ServeHTTP(rec, r)
		} else {
			timer := prometheus.NewTimer(httpRequestDuration.WithLabelValues(r.Method, path))
			next.ServeHTTP(rec, r)
			timer.ObserveDuration()
		}

		httpRequestsTotal.WithLabelValues(r.Method, path, strconv.Itoa(rec.status)).Inc()
	})
}
