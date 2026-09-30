package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/notification-svc/internal/auth"
	"github.com/task-board/notification-svc/internal/events"
	"github.com/task-board/notification-svc/internal/outbox"
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
		// The sidebar badge count — lightweight alternative to fetching the
		// full (up to 200) notification list just to count unread ones. See
		// docs/API-LAZY-LOADING-AUDIT.md D1/S3.
		r.Get("/notifications/unread-count", s.handleUnreadCount)
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
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Text           string  `json:"text"`
	TaskID         *string `json:"taskId"`
	ChannelID      *string `json:"channelId"`
	ConversationID *string `json:"conversationId"`
	MessageID      *string `json:"messageId"`
	CallID         *string `json:"callId"`
	Read           bool    `json:"read"`
	CreatedAt      string  `json:"createdAt"`
}

type notificationPageDTO struct {
	Items      []notificationDTO `json:"items"`
	NextCursor *string           `json:"nextCursor"`
}

type notificationCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

const (
	defaultNotificationPageSize = 10
	maxNotificationPageSize     = 50
)

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.FromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	legacyArray := r.URL.Query().Get("limit") == "" && r.URL.Query().Get("cursor") == ""
	limit := defaultNotificationPageSize
	if legacyArray {
		limit = 200
	}
	if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
		parsedLimit, err := strconv.Atoi(rawLimit)
		if err != nil || parsedLimit < 1 || parsedLimit > maxNotificationPageSize {
			writeError(w, http.StatusBadRequest, "invalid notification page size")
			return
		}
		limit = parsedLimit
	}

	var cursorTime, cursorID interface{}
	if rawCursor := r.URL.Query().Get("cursor"); rawCursor != "" {
		createdAt, id, err := decodeNotificationCursor(rawCursor)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid notification cursor")
			return
		}
		cursorTime, cursorID = createdAt, id
	}

	rows, err := s.pool.Query(r.Context(),
		`SELECT id, kind, text, task_id, channel_id, conversation_id, message_id, call_id, read_at, created_at
		   FROM notifications
		  WHERE recipient_id = $1
		    AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
		  ORDER BY created_at DESC, id DESC
		  LIMIT $4`,
		claims.UserID, cursorTime, cursorID, limit+1)
	if err != nil {
		s.log.Error("list notifications query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	out := make([]notificationDTO, 0, limit)
	var lastCreatedAt time.Time
	var lastID uuid.UUID
	hasMore := false
	for rows.Next() {
		var (
			id             uuid.UUID
			kind           string
			text           string
			taskID         *uuid.UUID
			channelID      *uuid.UUID
			conversationID *uuid.UUID
			messageID      *uuid.UUID
			callID         *uuid.UUID
			readAt         *time.Time
			createdAt      time.Time
		)
		if err := rows.Scan(&id, &kind, &text, &taskID, &channelID, &conversationID, &messageID, &callID, &readAt, &createdAt); err != nil {
			s.log.Error("scan notification failed", "error", err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if len(out) == limit {
			hasMore = true
			break
		}
		lastCreatedAt, lastID = createdAt, id
		var taskStr *string
		if taskID != nil {
			t := taskID.String()
			taskStr = &t
		}
		var channelStr *string
		if channelID != nil {
			c := channelID.String()
			channelStr = &c
		}
		var conversationStr *string
		if conversationID != nil {
			c := conversationID.String()
			conversationStr = &c
		}
		var messageStr *string
		if messageID != nil {
			m := messageID.String()
			messageStr = &m
		}
		var callStr *string
		if callID != nil {
			c := callID.String()
			callStr = &c
		}
		out = append(out, notificationDTO{
			ID:             id.String(),
			Kind:           kind,
			Text:           text,
			TaskID:         taskStr,
			ChannelID:      channelStr,
			ConversationID: conversationStr,
			MessageID:      messageStr,
			CallID:         callStr,
			Read:           readAt != nil,
			CreatedAt:      createdAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		})
	}
	if err := rows.Err(); err != nil {
		s.log.Error("rows iteration failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var nextCursor *string
	if hasMore {
		cursor := encodeNotificationCursor(lastCreatedAt, lastID)
		nextCursor = &cursor
	}
	if legacyArray {
		writeJSON(w, http.StatusOK, out)
		return
	}
	writeJSON(w, http.StatusOK, notificationPageDTO{Items: out, NextCursor: nextCursor})
}

func encodeNotificationCursor(createdAt time.Time, id uuid.UUID) string {
	payload, _ := json.Marshal(notificationCursor{CreatedAt: createdAt.UTC(), ID: id.String()})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeNotificationCursor(raw string) (time.Time, uuid.UUID, error) {
	var cursor notificationCursor
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	if err := json.Unmarshal(payload, &cursor); err != nil {
		return time.Time{}, uuid.Nil, err
	}
	id, err := uuid.Parse(cursor.ID)
	if err != nil || cursor.CreatedAt.IsZero() {
		return time.Time{}, uuid.Nil, errors.New("invalid cursor ordering key")
	}
	return cursor.CreatedAt.UTC(), id, nil
}

// unreadCountDTO is the response shape for handleUnreadCount.
type unreadCountDTO struct {
	UnreadCount int64 `json:"unreadCount"`
}

// handleUnreadCount serves GET /api/v1/notifications/unread-count. Unlike
// handleList (capped at the 200 most recent rows), this counts every unread
// notification the caller owns — a small, deliberate accuracy improvement
// over summing the capped list client-side, not just a lighter version of
// the same answer.
func (s *Server) handleUnreadCount(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.FromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var count int64
	err := s.pool.QueryRow(r.Context(),
		`SELECT count(*) FROM notifications
		  WHERE recipient_id = $1 AND read_at IS NULL`,
		claims.UserID).Scan(&count)
	if err != nil {
		s.log.Error("unread count query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, unreadCountDTO{UnreadCount: count})
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

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		s.log.Error("begin tx failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	exists, err := s.markRead(r.Context(), tx, id, claims.UserID, claims.OrgID)
	if err != nil {
		s.log.Error("mark read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "notification not found")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		s.log.Error("commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// markRead updates one notification's read_at and, only when the row actually
// flips from unread to read, enqueues a NotificationRead event on the same
// transaction. Returns whether the notification exists at all (owned by this
// caller) — RowsAffected alone can't distinguish "already read" from "not
// found", and the caller needs that distinction for 404 vs 204.
//
// Split out from handleRead so this DB-level behavior (in particular: exactly
// one event per real change, none for an idempotent re-read) is testable
// without going through HTTP/auth — see httpapi_test.go.
func (s *Server) markRead(ctx context.Context, tx pgx.Tx, id uuid.UUID, userID, orgID string) (exists bool, err error) {
	tag, err := tx.Exec(ctx,
		`UPDATE notifications
		    SET read_at = now()
		  WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL`,
		id, userID)
	if err != nil {
		return false, err
	}

	if tag.RowsAffected() > 0 {
		idStr := id.String()
		return true, s.publishNotificationRead(ctx, tx, orgID, userID, &idStr)
	}

	// Either not found / not owned, or already read. Verify existence to
	// distinguish a genuine 404 from an idempotent re-read — already read
	// changed nothing, so no event: a second click on "Mark read" must not
	// re-broadcast to every active session.
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM notifications WHERE id=$1 AND recipient_id=$2)`,
		id, userID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
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

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		s.log.Error("begin tx failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if err := s.markAllRead(r.Context(), tx, claims.UserID, claims.OrgID); err != nil {
		s.log.Error("mark all read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		s.log.Error("commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// markAllRead marks every unread notification the caller owns as read in a
// single set-based statement, and — only when at least one row actually
// changed — enqueues one NotificationRead event (not one per row: a bulk
// mark-read is one user action, and the frontend response to the event is a
// blind refetch regardless of which rows changed). Split out for the same
// testability reason as markRead above.
func (s *Server) markAllRead(ctx context.Context, tx pgx.Tx, userID, orgID string) error {
	tag, err := tx.Exec(ctx,
		`UPDATE notifications
		    SET read_at = now()
		  WHERE recipient_id = $1 AND read_at IS NULL`,
		userID)
	if err != nil {
		return err
	}

	// Nothing changed — nothing to tell other sessions.
	if tag.RowsAffected() == 0 {
		return nil
	}
	return s.publishNotificationRead(ctx, tx, orgID, userID, nil)
}

// publishNotificationRead enqueues a NotificationRead outbox row on the
// caller's transaction, the same Enqueue-in-tx pattern consumer.go uses for
// NotificationCreated — the existing outbox.Publisher picks it up from here
// with no other wiring needed.
func (s *Server) publishNotificationRead(ctx context.Context, tx pgx.Tx, orgID, recipientID string, notificationID *string) error {
	outID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	evt := events.NotificationRead{
		Type:           events.TypeNotificationRead,
		EventID:        outID.String(),
		OrgID:          orgID,
		OccurredAt:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		RecipientID:    recipientID,
		NotificationID: notificationID,
	}
	payload, err := json.Marshal(evt)
	if err != nil {
		return err
	}
	return outbox.Enqueue(ctx, tx, outID, events.TopicNotification, recipientID, orgID, payload)
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
