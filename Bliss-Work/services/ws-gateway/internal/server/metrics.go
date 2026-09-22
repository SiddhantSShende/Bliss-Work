package server

import (
	"net/http"
	"strconv"
	"time"

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

// unmatchedPath is the "path" label for a request no route claimed.
const unmatchedPath = "unmatched"

// methodLabel bounds the "method" label: Go accepts any token as an HTTP method,
// so passing r.Method through would let a client mint series at will.
func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return method
	}
	return "OTHER"
}

// metrics records request counts and durations for every route except
// /metrics itself.
//
// The "path" label is the mux pattern that handled the request, read after the
// mux has run (it records the match on the request), NEVER r.URL.Path: the path is
// client-chosen, and every distinct one — a scanner's /a/1, /a/2, … — would create
// its own counter plus a full histogram in this process for as long as it lives.
// Requests no route matches share one "unmatched" series.
func metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == metricsPath {
			// Never instrument the scrape endpoint.
			next.ServeHTTP(w, r)
			return
		}

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		method := methodLabel(r.Method)
		start := time.Now()
		next.ServeHTTP(rec, r)

		path := r.Pattern
		if path == "" {
			path = unmatchedPath
		}
		// Only time non-websocket routes. A long-lived /ws connection would
		// skew the latency histogram, so it is counted but not observed.
		if path != wsPath {
			httpRequestDuration.WithLabelValues(method, path).Observe(time.Since(start).Seconds())
		}
		httpRequestsTotal.WithLabelValues(method, path, strconv.Itoa(rec.status)).Inc()
	})
}
