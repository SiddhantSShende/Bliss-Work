package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/delivery"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/signal"
	"github.com/task-board/ws-gateway/internal/store"
)

// allowedOriginRe matches the web origin host as well as Electron app/file
// origins (which present "null", "file://" or "app://" Origins).
var allowedOriginRe = regexp.MustCompile(`(?i)^(https?://(localhost|127\.0\.0\.1)(:\d+)?|file://.*|app://.*|null)$`)

// Server wires HTTP + websocket handling.
type Server struct {
	cfg        Config
	verifier   *auth.Verifier
	hub        *hub.Hub
	store      *store.Store
	dispatcher *delivery.Dispatcher
	signal     *signal.Dispatcher
	nodeID     string
	log        *slog.Logger
}

// Config holds server dependencies.
type Config struct {
	WebOrigin string
	// Connection caps enforced at upgrade time (see hub.Add). 0 = unlimited.
	MaxConnections  int
	MaxConnsPerUser int
}

// New constructs a Server. dispatcher / sig may be nil in tests; in production
// they are driven by cmd/ws-gateway/main.go.
func New(
	cfg Config,
	v *auth.Verifier,
	h *hub.Hub,
	st *store.Store,
	d *delivery.Dispatcher,
	sig *signal.Dispatcher,
	nodeID string,
	log *slog.Logger,
) *Server {
	return &Server{cfg: cfg, verifier: v, hub: h, store: st, dispatcher: d, signal: sig, nodeID: nodeID, log: log}
}

// Handler returns the root HTTP mux. Order of wrappers (outermost first):
//
//	requestID  → tag every response with X-Request-Id
//	recoverer  → catch panics on non-websocket routes (stdlib has no Recoverer)
//	cors       → echo credentialed CORS for browser + Electron
//	metrics    → record Prometheus request counters/durations (skips /metrics)
//	mux        → routes
//
// /metrics is served by promhttp and scraped unauthenticated. The metrics
// middleware guards on path "/metrics" so it never instruments the scrape
// endpoint itself, and Prometheus has no auth/ratelimit applied here.
func (s *Server) Handler() http.Handler {
	// ws_connections reflects the live socket count on this node, read from the
	// hub at scrape time via a func gauge — no background goroutine, no risk of
	// drift if a Remove path is ever missed. Register (not MustRegister) so a
	// repeat Handler() call (e.g. in tests) tolerates AlreadyRegisteredError
	// instead of panicking.
	gauge := prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "ws_connections",
			Help: "Number of websocket connections currently registered on this node.",
		},
		func() float64 { return float64(s.hub.Count()) },
	)
	if err := prometheus.Register(gauge); err != nil {
		var already prometheus.AlreadyRegisteredError
		if !errors.As(err, &already) {
			s.log.Warn("ws_connections gauge registration failed", "err", err)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/presence", s.handlePresence)
	mux.Handle("/metrics", promhttp.Handler())
	return requestID(securityHeaders(recoverer(s.log)(s.cors(metrics(mux)))))
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// handleReadyz is a readiness probe: it verifies the gateway's critical
// dependency (Redis) is reachable before reporting the service ready to take
// traffic. Unlike /healthz (a cheap liveness check), a failure here returns 503
// so orchestrators stop routing to this instance. The Ping is bounded by a
// short timeout so the probe itself can never hang.
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		s.log.Warn("readiness check failed", "err", err)
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready"))
}

// handlePresence returns the IDs of users currently connected within the
// caller's org (derived from the verified Bearer token).
func (s *Server) handlePresence(w http.ResponseWriter, r *http.Request) {
	claims, err := s.verifier.Verify(r.Context(), extractToken(r))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ids, err := s.store.OnlineUserIDs(r.Context(), claims.OrgID)
	if err != nil {
		s.log.Error("presence query failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ids)
}

// cors applies credentialed CORS for the configured web origin and Electron.
// Credentialed requests forbid the "*" wildcard, so echo the specific origin
// and the requested headers.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (origin == s.cfg.WebOrigin || allowedOriginRe.MatchString(origin)) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			reqHeaders := r.Header.Get("Access-Control-Request-Headers")
			if reqHeaders == "" {
				reqHeaders = "Authorization, Content-Type"
			}
			w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// extractToken reads the bearer token from the Authorization header or, failing
// that, the ?token= query parameter.
func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(strings.ToLower(h), "bearer ") {
			return strings.TrimSpace(h[len("Bearer "):])
		}
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	claims, err := s.verifier.Verify(r.Context(), token)
	if err != nil {
		s.log.Warn("ws auth rejected", "err", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin checks already enforced for browsers via JWT; allow Electron.
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.log.Warn("ws accept failed", "err", err)
		return
	}

	s.serveConn(r.Context(), c, claims)
}
