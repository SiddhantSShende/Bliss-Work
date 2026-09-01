package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/notification-svc/internal/auth"
)

// HeaderRequestID is the case-insensitive request-id header all services emit.
const HeaderRequestID = "X-Request-Id"

// Desktop origins (file://, app://, and the literal `null` Chromium sends from a
// file:// document) are allowed everywhere; loopback origins only in non-prod
// (gated in cors() on the web origin scheme).
var desktopOriginRe = regexp.MustCompile(`^(app://.*|file://.*|null)$`)
var localhostOriginRe = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)

// Server wires the REST API.
type Server struct {
	pool      *pgxpool.Pool
	verifier  *auth.Verifier
	log       *slog.Logger
	webOrigin string
}

// New constructs a Server.
func New(pool *pgxpool.Pool, verifier *auth.Verifier, webOrigin string, log *slog.Logger) *Server {
	return &Server{pool: pool, verifier: verifier, webOrigin: webOrigin, log: log}
}

// Router builds the chi router with all routes.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(s.requestID)
	r.Use(s.securityHeaders)
	r.Use(s.recoverer)
	r.Use(s.cors)
	// metrics records request counters/latency for every route. It self-excludes
	// the /metrics scrape endpoint by path, so the Prometheus handler below is
	// not instrumented even though it shares this middleware chain.
	r.Use(s.metrics)

	// /metrics is scraped by Prometheus unauthenticated — register it outside
	// the auth-protected /api/v1 group.
	r.Handle("/metrics", promhttp.Handler())

	r.Get("/healthz", s.handleHealthz)
	r.Get("/readyz", s.handleReadyz)

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(s.verifier.Middleware)
		r.Get("/notifications", s.handleList)
		r.Post("/notifications/read-all", s.handleReadAll)
		r.Post("/notifications/{id}/read", s.handleRead)
	})

	return r
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowLocalhost := !strings.HasPrefix(s.webOrigin, "https://")
		if origin != "" && (origin == s.webOrigin || desktopOriginRe.MatchString(origin) ||
			(allowLocalhost && localhostOriginRe.MatchString(origin))) {
			// Credentialed CORS: must echo the specific origin and cannot use
			// the "*" wildcard for methods/headers — echo the requested headers.
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
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

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	// IMAGE_TAG is set by docker-compose.prod.yml from the deployed commit's
	// short SHA; defaults to "dev" when unset (e.g. a local run outside compose).
	version := os.Getenv("IMAGE_TAG")
	if version == "" {
		version = "dev"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version})
}

// handleReadyz is the readiness probe. Unlike /healthz (a cheap liveness check),
// it verifies the service's critical dependency — Postgres — is reachable before
// declaring the instance ready to serve traffic. A short context timeout keeps
// the probe itself from hanging when the DB is slow or unreachable.
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	if err := s.pool.Ping(ctx); err != nil {
		s.log.Error("readiness check failed", "error", err)
		writeError(w, http.StatusServiceUnavailable, "database unreachable")
		return
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready"))
}

type notificationDTO struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Text      string  `json:"text"`
	TaskID    *string `json:"taskId"`
	Read      bool    `json:"read"`
	CreatedAt string  `json:"createdAt"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.FromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	rows, err := s.pool.Query(r.Context(),
		`SELECT id, kind, text, task_id, read_at, created_at
		   FROM notifications
		  WHERE recipient_id = $1 AND org_id = $2
		  ORDER BY created_at DESC
		  LIMIT 200`,
		claims.UserID, claims.OrgID)
	if err != nil {
		s.log.Error("list notifications query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	out := make([]notificationDTO, 0)
	for rows.Next() {
		var (
			id        uuid.UUID
			kind      string
			text      string
			taskID    *uuid.UUID
			readAt    *time.Time
			createdAt time.Time
		)
		if err := rows.Scan(&id, &kind, &text, &taskID, &readAt, &createdAt); err != nil {
			s.log.Error("scan notification failed", "error", err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		var taskStr *string
		if taskID != nil {
			t := taskID.String()
			taskStr = &t
		}
		out = append(out, notificationDTO{
			ID:        id.String(),
			Kind:      kind,
			Text:      text,
			TaskID:    taskStr,
			Read:      readAt != nil,
			CreatedAt: createdAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		})
	}
	if err := rows.Err(); err != nil {
		s.log.Error("rows iteration failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.FromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid notification id")
		return
	}

	tag, err := s.pool.Exec(r.Context(),
		`UPDATE notifications
		    SET read_at = now()
		  WHERE id = $1 AND recipient_id = $2 AND org_id = $3 AND read_at IS NULL`,
		id, claims.UserID, claims.OrgID)
	if err != nil {
		s.log.Error("mark read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if tag.RowsAffected() == 0 {
		// Either not found / not owned, or already read. Verify existence to
		// distinguish a genuine 404 from an idempotent re-read.
		var exists bool
		err := s.pool.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM notifications WHERE id=$1 AND recipient_id=$2 AND org_id=$3)`,
			id, claims.UserID, claims.OrgID).Scan(&exists)
		if err != nil {
			s.log.Error("existence check failed", "error", err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "notification not found")
			return
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

// handleReadAll serves POST /api/v1/notifications/read-all. Marks every unread
// notification the caller owns as read in a single set-based statement (no
// per-id round-trip), so the bell can auto-clear when the panel is opened.
// Idempotent — a second call touches 0 rows and still returns 204.
func (s *Server) handleReadAll(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.FromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if _, err := s.pool.Exec(r.Context(),
		`UPDATE notifications
		    SET read_at = now()
		  WHERE recipient_id = $1 AND org_id = $2 AND read_at IS NULL`,
		claims.UserID, claims.OrgID); err != nil {
		s.log.Error("mark all read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// errorBody matches packages/shared/src/types/errors.ts ApiErrorBody.
type errorBody struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
}

// writeError emits the canonical envelope. We keep the legacy signature so all
// existing handlers continue compiling; requestId comes from the response
// header (set by requestID middleware), not from the request — close enough
// for the common case.
func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Error: errorPayload{
		Code:      codeForStatus(status),
		Message:   msg,
		RequestID: w.Header().Get(HeaderRequestID),
	}})
}

func codeForStatus(s int) string {
	switch s {
	case http.StatusBadRequest:
		return "bad_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusUnprocessableEntity:
		return "validation_error"
	case http.StatusTooManyRequests:
		return "rate_limited"
	case http.StatusGatewayTimeout:
		return "gateway_timeout"
	case http.StatusServiceUnavailable:
		return "service_unavailable"
	}
	if s >= 500 {
		return "internal_error"
	}
	return "bad_request"
}

// securityHeaders sets the OWASP-recommended response headers. Identical set
// across all Task-Board services (Go + FastAPI).
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	headers := map[string]string{
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "strict-origin-when-cross-origin",
		"Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
		"Content-Security-Policy":   "default-src 'none'; frame-ancestors 'none'",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		for k, v := range headers {
			if h.Get(k) == "" {
				h.Set(k, v)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requestID stamps X-Request-Id (forwarded by client or freshly minted) on the
// response so writeError can echo it. Replaces chi/middleware.RequestID, which
// only puts the id in context — we also want it on the response header so the
// frontend's ApiError can pick it up before parsing the body.
func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get(HeaderRequestID)
		if rid == "" || len(rid) > 128 {
			rid = uuid.NewString()
		}
		w.Header().Set(HeaderRequestID, rid)
		next.ServeHTTP(w, r)
	})
}

// recoverer is a request-aware panic recoverer that emits the canonical body.
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic recovered",
					"err", rec,
					"path", r.URL.Path,
					"request_id", w.Header().Get(HeaderRequestID),
				)
				writeError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
