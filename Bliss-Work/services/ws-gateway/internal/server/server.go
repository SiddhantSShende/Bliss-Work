package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 -- coturn REST API mandates HMAC-SHA1 for TURN creds
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/delivery"
	"github.com/task-board/ws-gateway/internal/hub"
	// Aliased: this package's request middleware is itself called `metrics`
	// (see metrics.go), so the bare package name would collide with it.
	wsmetrics "github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/presence"
	"github.com/task-board/ws-gateway/internal/push"
	"github.com/task-board/ws-gateway/internal/signal"
	"github.com/task-board/ws-gateway/internal/store"
)

// Electron desktop origins (file://, app://, and the "null" Origin Chromium
// sends from a file:// document) are allowed in every environment; loopback
// origins only in non-prod (gated in cors() on the web-origin scheme).
var desktopOriginRe = regexp.MustCompile(`(?i)^(file://.*|app://.*|null)$`)
var localhostOriginRe = regexp.MustCompile(`(?i)^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)

// Server wires HTTP + websocket handling.
type Server struct {
	cfg        Config
	verifier   *auth.Verifier
	hub        *hub.Hub
	store      *store.Store
	dispatcher *delivery.Dispatcher
	signal     *signal.Dispatcher
	presence   *presence.Broadcaster
	nodeID     string
	log        *slog.Logger
}

// Config holds server dependencies.
type Config struct {
	WebOrigin string
	// Connection caps enforced at upgrade time (see hub.Add). 0 = unlimited.
	MaxConnections  int
	MaxConnsPerUser int
	// WSGatewayInternalToken authorizes the routed-delivery push endpoint (see
	// push.go) — this service's OWN secret (WS_GATEWAY_INTERNAL_TOKEN), not
	// shared with any other service's callees. Empty disables the endpoint
	// entirely — it answers 401 to everything — which is the correct posture
	// for a deployment not using routed delivery.
	WSGatewayInternalToken string
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
	pres *presence.Broadcaster,
	nodeID string,
	log *slog.Logger,
) *Server {
	return &Server{cfg: cfg, verifier: v, hub: h, store: st, dispatcher: d, signal: sig, presence: pres, nodeID: nodeID, log: log}
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
	// The bounded form: "are these N users online" rather than "who in my org
	// is online". Additive — /presence stays until clients have moved.
	mux.HandleFunc("/presence/query", s.handlePresenceQuery)
	mux.HandleFunc("/turn-credentials", s.handleTurnCredentials)
	// Routed fan-out delivery, authorized by the shared internal token rather
	// than a user JWT. MUST NOT be reachable from the public edge — the
	// Caddyfile only proxies the browser-facing routes, and this is not one.
	mux.HandleFunc(push.Path, s.handlePush)
	mux.Handle("/metrics", promhttp.Handler())
	return requestID(securityHeaders(recoverer(s.log)(s.cors(metrics(mux)))))
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	// IMAGE_TAG is set by docker-compose.prod.yml from the deployed commit's
	// short SHA; defaults to "dev" when unset (e.g. a local run outside compose).
	version := os.Getenv("IMAGE_TAG")
	if version == "" {
		version = "dev"
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": version})
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

// maxPresenceQuery bounds one presence query. Generous next to a screenful of
// avatars and finite, so this cannot become a way to make the gateway issue an
// unbounded pipeline on an unauthenticated-adjacent path.
const maxPresenceQuery = 500

// handlePresenceQuery answers "which of THESE users are online".
//
// The bounded counterpart to /presence, and the one clients should move to.
// /presence returns every online member of the caller's org, which means one
// Redis key whose size and read rate scale with the organisation — and that is
// the one part of the keyspace sharding cannot help, because a key lives on one
// node no matter how many nodes exist.
//
// This reads per-user keys instead, which are hash-tagged by user id and shard
// evenly, and its cost scales with what the client is actually displaying.
//
// POST rather than GET because the user list is the request, and a few hundred
// ids do not belong in a query string.
func (s *Server) handlePresenceQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims, err := s.verifier.Verify(r.Context(), extractToken(r))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		UserIDs []string `json:"userIds"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if len(body.UserIDs) > maxPresenceQuery {
		http.Error(w, "too many userIds", http.StatusBadRequest)
		return
	}

	online, err := s.store.OnlineAmong(r.Context(), body.UserIDs)
	if err != nil {
		s.log.Error("presence query failed", "err", err, "org", claims.OrgID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// NOTE: the answer is not filtered by the caller's org. Presence for a user
	// id you already hold is not a disclosure — you had to know the id to ask —
	// and filtering would mean a per-user org lookup, which is precisely the
	// cross-key read this endpoint exists to avoid. The org-scoped view is
	// still /presence.
	if online == nil {
		online = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(online)
}

// TURN REST config (coturn use-auth-secret). The static secret never leaves the
// server; clients get a short-lived username/password derived from it. STUN/TURN
// URLs are injected from the environment so the same binary runs anywhere.
var (
	turnSecret = os.Getenv("TURN_SECRET")
	turnURLs   = splitList(os.Getenv("TURN_URLS"))
	stunURLs   = splitList(os.Getenv("STUN_URLS"))
)

// turnTTL is how long a minted TURN credential stays valid (seconds). The client
// re-fetches before placing a call, so a call never starts on a stale credential.
const turnTTL = 3600

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// handleTurnCredentials returns the ICE servers for a WebRTC call. STUN entries
// need no auth; TURN entries carry a short-lived HMAC-SHA1 credential (the coturn
// long-term-credential REST API). A valid access token is required so only
// authenticated users can mint TURN credentials. When TURN is unconfigured it
// returns STUN-only (or an empty list) so calls degrade gracefully.
func (s *Server) handleTurnCredentials(w http.ResponseWriter, r *http.Request) {
	claims, err := s.verifier.Verify(r.Context(), extractToken(r))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	type iceServer struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username,omitempty"`
		Credential string   `json:"credential,omitempty"`
	}
	servers := make([]iceServer, 0, 2)
	if len(stunURLs) > 0 {
		servers = append(servers, iceServer{URLs: stunURLs})
	}
	// Whether a relay was actually on offer, not just whether the request
	// succeeded. With no TURN secret or URL this endpoint still answers 200 —
	// with STUN only — and every client behind a symmetric NAT then fails to
	// connect while the API looks perfectly healthy. Counting the two cases
	// apart is what makes that visible; `turn="unavailable"` climbing means
	// calls are failing for a reason no error rate will show.
	turnState := wsmetrics.TurnUnavailable
	if turnSecret != "" && len(turnURLs) > 0 {
		turnState = wsmetrics.TurnOffered
	}
	wsmetrics.TurnCredentialsTotal.WithLabelValues(turnState).Inc()

	if turnSecret != "" && len(turnURLs) > 0 {
		// coturn REST: username = "<expiryUnix>:<userId>", credential =
		// base64(HMAC-SHA1(secret, username)).
		expiry := time.Now().Add(turnTTL * time.Second).Unix()
		username := fmt.Sprintf("%d:%s", expiry, claims.UserID)
		mac := hmac.New(sha1.New, []byte(turnSecret))
		_, _ = mac.Write([]byte(username))
		servers = append(servers, iceServer{
			URLs:       turnURLs,
			Username:   username,
			Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"iceServers": servers, "ttl": turnTTL})
}

// cors applies credentialed CORS for the configured web origin and Electron.
// Credentialed requests forbid the "*" wildcard, so echo the specific origin
// and the requested headers.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowLocalhost := !strings.HasPrefix(s.cfg.WebOrigin, "https://")
		if origin != "" && (origin == s.cfg.WebOrigin || desktopOriginRe.MatchString(origin) ||
			(allowLocalhost && localhostOriginRe.MatchString(origin))) {
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
