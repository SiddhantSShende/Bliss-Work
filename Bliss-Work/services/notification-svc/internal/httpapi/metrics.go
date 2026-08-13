package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
)

// Prometheus collectors for the REST API. Registered exactly once via the
// package init() so importing httpapi can never double-register (which would
// panic on a duplicate-metric error).
var (
	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests processed, labeled by method, route pattern and status code.",
		},
		[]string{"method", "path", "status"},
	)

	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "Latency of HTTP requests in seconds, labeled by method and route pattern.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
)

func init() {
	prometheus.MustRegister(httpRequestsTotal, httpRequestDuration)
}

// statusRecorder wraps http.ResponseWriter to capture the status code. It
// defaults to 200 because a handler that writes a body without calling
// WriteHeader implicitly returns 200.
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
	// An implicit 200 happens on the first Write without an explicit
	// WriteHeader; mark it so the status is recorded correctly.
	if !r.wroteHeader {
		r.wroteHeader = true
	}
	return r.ResponseWriter.Write(b)
}

// metrics is the instrumentation middleware. It records http_requests_total and
// http_request_duration_seconds for every request EXCEPT the /metrics endpoint
// itself (Prometheus scrapes that unauthenticated and we don't want it skewing
// or self-counting).
//
// The "path" label uses chi's route PATTERN (e.g. /api/v1/notifications/{id}/read)
// rather than the raw URL, which would embed UUIDs and explode cardinality. The
// pattern is only populated after chi has routed the request, so this middleware
// must run inside the router (registered via r.Use), not wrapped around it.
func (s *Server) metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never instrument the scrape endpoint itself.
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()

		next.ServeHTTP(rec, r)

		// Resolve the route pattern after routing; fall back to "other" for
		// unmatched routes (404s) so we never label by raw, high-cardinality URL.
		path := "other"
		if rc := chi.RouteContext(r.Context()); rc != nil {
			if p := rc.RoutePattern(); p != "" {
				path = p
			}
		}

		method := r.Method
		httpRequestsTotal.WithLabelValues(method, path, strconv.Itoa(rec.status)).Inc()
		httpRequestDuration.WithLabelValues(method, path).Observe(time.Since(start).Seconds())
	})
}
