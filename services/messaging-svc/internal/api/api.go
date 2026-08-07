// Package api wires the HTTP routes for messaging-svc.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/media"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// smallBody is the request-body cap for ordinary JSON endpoints (chat messages,
// member lists). Generous for text plus UUID lists, small enough that an
// oversized payload cannot be buffered into the heap as a cheap DoS.
const smallBody = 1 << 20

// Server holds handler dependencies.
type Server struct {
	store    *store.Store
	verifier *auth.Verifier
	log      *slog.Logger
	limiter  *mw.Limiter

	// Attachment plumbing: the on-disk blob store, the HMAC signer for
	// download URLs, and their configuration.
	blobs    *blob.Store
	signer   *media.Signer
	mediaCfg config.MediaConfig
	mapsCfg  config.MapsConfig
}

// NewServer constructs an API server.
func NewServer(
	st *store.Store,
	v *auth.Verifier,
	log *slog.Logger,
	blobs *blob.Store,
	signer *media.Signer,
	mediaCfg config.MediaConfig,
	mapsCfg config.MapsConfig,
) *Server {
	return &Server{
		store:    st,
		verifier: v,
		log:      log,
		limiter:  mw.NewLimiter(mw.DefaultLimits),
		blobs:    blobs,
		signer:   signer,
		mediaCfg: mediaCfg,
		mapsCfg:  mapsCfg,
	}
}

// Router builds the chi router with CORS, health, and the authed API group.
func (s *Server) Router(webOrigin string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(mw.RequestID)
	r.Use(mw.SecurityHeaders)
	r.Use(s.recoverer)
	// Phase 5: Prometheus instrumentation. Wraps every route so the chi route
	// pattern is resolvable for the low-cardinality "path" label. Self-guards
	// against the /metrics scrape endpoint, so /metrics is never instrumented.
	r.Use(mw.Metrics)

	// ── Request body caps are applied PER GROUP, not here at the root ────────
	//
	// ⚠️ Every route that accepts a body MUST live inside a group that applies
	// mw.MaxBytes. There is no root-level cap to fall back on, and a route that
	// forgets one loses its DoS protection SILENTLY — no error, no failing test
	// unless you add one. See maxbytes_test.go, which asserts the caps are
	// actually in force on representative routes.
	//
	// The cap moved off the root because the attachment upload needs 100 MB and
	// http.MaxBytesReader does not "widen" when nested: an outer 1 MiB reader is
	// the underlying stream for the inner one, so it still trips first.

	// Desktop origins (file://, app://, and the literal `null` Chromium sends from
	// a file:// document) are allowed in every environment. Loopback origins only
	// when NOT serving a prod (https) web origin. AllowOriginFunc MUST carry the
	// web origin itself — go-chi/cors ignores AllowedOrigins whenever
	// AllowOriginFunc is set (the prior code's AllowedOrigins was dead config).
	desktopRe := regexp.MustCompile(`^(file://.*|app://.*|null)$`)
	localhostRe := regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)
	allowLocalhost := !strings.HasPrefix(webOrigin, "https://")
	r.Use(cors.Handler(cors.Options{
		AllowOriginFunc: func(_ *http.Request, origin string) bool {
			return origin == webOrigin || desktopRe.MatchString(origin) ||
				(allowLocalhost && localhostRe.MatchString(origin))
		},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true, // browser sends the auth cookie cross-origin
	}))

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Phase 5: Prometheus scrape endpoint. Sibling of /healthz — outside the
	// /api/v1 JWT+ratelimit group so Prometheus can scrape it unauthenticated.
	// The Metrics middleware self-guards on this path, so the scrape endpoint is
	// not itself instrumented.
	r.Handle("/metrics", promhttp.Handler())

	// Phase 5: readiness probe. Unlike /healthz (cheap liveness), /readyz checks
	// our critical dependency — Postgres — so an orchestrator won't route traffic
	// to a replica whose DB is unreachable. Sibling of /healthz, outside the
	// /api/v1 JWT+ratelimit group. Short timeout so the probe can't hang.
	r.Get("/readyz", s.readyz)

	// Phase 5: internal-only service-to-service endpoints. Not under /api/v1
	// (no JWT middleware). Auth via X-Internal-Token in the handler.
	// Intentionally not CORS-allowed for browser callers. Small JSON bodies.
	r.Group(func(g chi.Router) {
		g.Use(mw.MaxBytes(smallBody))
		g.Post("/internal/messages/delivered", s.markDelivered)
		// task-svc resolves channel members here when fanning out a channel-
		// allocated task. Same shared-secret auth as the delivery endpoint.
		g.Get("/internal/channels/{id}/members", s.internalChannelMembers)
	})

	// ── Signed attachment download ───────────────────────────────────────────
	// Deliberately OUTSIDE /api/v1, so the JWT middleware does NOT run: a
	// browser cannot put an Authorization header on <img src> or <video src>.
	// The short-lived HMAC token in the query string authenticates instead, and
	// the handler re-checks scope membership as the granted user on every hit —
	// so losing access to a channel revokes its files immediately rather than
	// when the token happens to expire.
	//
	// GET carries no body, so no MaxBytes is needed. The per-IP limiter still
	// applies. CORS is intentionally not applied: these URLs are loaded as
	// subresources, not fetched, so no preflight is involved.
	r.Group(func(g chi.Router) {
		g.Use(s.limiter.PerIPMiddleware)
		g.Get("/media/{id}", s.downloadMedia)
	})

	idempotency := mw.Idempotency(s.store.Pool(), s.log)

	r.Route("/api/v1", func(r chi.Router) {
		// Per-IP limiter runs first inside this group (healthz is excluded so
		// liveness probes aren't rate-limited). It runs before JWT verification
		// so floods get rejected cheap.
		r.Use(s.limiter.PerIPMiddleware)
		r.Use(s.verifier.Middleware)
		// Per-user limiter runs after verifier so we have a userId to bucket by.
		r.Use(s.limiter.PerUserMiddleware(func(req *http.Request) string {
			if claims, ok := auth.FromContext(req.Context()); ok {
				return claims.UserID
			}
			return ""
		}))

		// ── Attachment upload — the ONE large-body route ─────────────────
		// Capped in the handler at MEDIA_MAX_BYTES (+ multipart framing) via
		// http.MaxBytesReader, and streamed straight to disk. It sits outside
		// the small-body group below because a nested MaxBytesReader cannot
		// widen an outer one.
		r.Post("/attachments", s.uploadAttachment)

		// Everything else keeps the 1 MiB cap.
		r.Group(func(r chi.Router) {
			r.Use(mw.MaxBytes(smallBody))

			r.Post("/conversations/messages", s.sendMessage)
			r.Get("/conversations", s.listConversations)
			r.Post("/conversations/{id}/reply", s.reply)
			r.Post("/conversations/{id}/ignore", s.ignore)
			r.Get("/conversations/{id}/messages", s.listMessages)
			r.Post("/conversations/{id}/read", s.markRead)
			r.Post("/users/{id}/block", s.block)
			r.Delete("/users/{id}/block", s.unblock)

			// Attachment metadata routes — small JSON, so they stay behind the
			// 1 MiB cap (and, at the edge, behind the WAF) unlike the upload.
			r.Post("/attachments/{id}/commit", s.commitAttachment)
			r.Post("/attachments/links", s.attachmentLinks)

			// Static map thumbnails for shared locations. Proxied server-side so
			// the image is same-origin, the user's IP never reaches the provider
			// and the API key stays off the client. Returns 204 when unavailable.
			r.Get("/maps/static", s.staticMap)

			// Forward tracking is available to every org — each org brings its own
			// third-party credentials, so it is NOT a Bliss-Work paid tier. Any
			// authenticated org member may forward. Clone-to-another-user is idempotent
			// via appendMessage's natural clientMsgId, so it stays out of the
			// idempotency group.
			r.Post("/messages/{id}/forward", s.forwardMessage)
			r.Post("/messages/{id}/forward-external", s.forwardExternal)
			r.Get("/messages/{id}/forwards", s.listForwards)
			r.Get("/forwards/activity", s.listForwardActivity)

			r.Post("/channels", s.createChannel)
			r.Get("/channels", s.listChannels)
			r.Get("/channels/open", s.listOpenChannels)
			r.Get("/channels/{id}/messages", s.listChannelMessages)
			r.Post("/channels/{id}/messages", s.sendChannelMessage)
			r.Get("/channels/{id}/members", s.listChannelMembers)
			r.Post("/channels/{id}/members", s.addChannelMembers)
			r.Post("/channels/{id}/join", s.joinChannel)
			r.Post("/channels/{id}/leave", s.leaveChannel)

			// ── Phase 3: unified inbox + email-style threads ───────────────
			r.Get("/inbox", s.listInbox)
			r.Get("/inbox/peers", s.listInboxPeers)
			r.Get("/threads/{id}", s.getThread)
			r.Get("/threads/{id}/messages", s.listThreadMessages)
			r.Post("/threads/{id}/reply", s.replyToThread)

			// Idempotent state-mutators (no natural client_msg_id).
			r.Group(func(g chi.Router) {
				g.Use(idempotency)
				g.Post("/threads/{id}/ignore", s.ignoreThread)
				g.Post("/threads/{id}/read", s.readThread)
				g.Post("/messages/{id}/dismiss", s.dismissMessage)
				g.Post("/inbox/items/{kind}/{refId}/ignore", s.ignoreInboxItem)
				g.Post("/inbox/items/{kind}/{refId}/read", s.markInboxItemRead)
			})
		})
	})

	return r
}

// ── helpers ───────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr emits the canonical error envelope. Status is the HTTP code; the
// ErrorCode is derived from the status by default.
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeErrR(w, nil, code, msg)
}

// writeErrR is the request-aware variant — it picks up the X-Request-Id stamped
// by the RequestID middleware so the body carries `requestId`.
func writeErrR(w http.ResponseWriter, r *http.Request, code int, msg string) {
	if r != nil {
		writeAPIError(w, r, code, httpStatusToCode(code), msg, nil)
		return
	}
	// Fallback when handler didn't pass r (rare). We can still recover the
	// request-id from the response header — RequestID middleware set it as
	// soon as the request entered the stack.
	rid := w.Header().Get(mw.HeaderRequestID)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(apiErrorBody{
		Error: apiErrorPayload{Code: httpStatusToCode(code), Message: msg, RequestID: rid},
	})
}

func (s *Server) mapErr(w http.ResponseWriter, err error) {
	s.mapErrR(w, nil, err)
}

func (s *Server) mapErrR(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := mapStoreError(err)
	rid := mw.RequestIDFromContext(reqCtx(r))
	if rid == "" {
		// r was nil or context didn't carry one; fall back to the response
		// header which the middleware already populated.
		rid = w.Header().Get(mw.HeaderRequestID)
	}
	if status >= 500 {
		s.log.Error("request failed", "err", err, "request_id", rid)
	}
	if r != nil {
		writeAPIError(w, r, status, code, msg, nil)
		return
	}
	// Fallback path; status/code/msg are still canonical, and we recovered rid.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiErrorBody{Error: apiErrorPayload{Code: code, Message: msg, RequestID: rid}})
}

// reqCtx returns r.Context() or context.Background() to keep the logger happy.
func reqCtx(r *http.Request) context.Context {
	if r == nil {
		return context.Background()
	}
	return r.Context()
}

// recoverer is a request-aware panic recoverer that emits the canonical error
// envelope and logs with the request id. Replaces chi.middleware.Recoverer so
// panics don't escape as bare 500s.
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic", "err", rec, "request_id", mw.RequestIDFromContext(r.Context()), "path", r.URL.Path)
				writeAPIError(w, r, http.StatusInternalServerError, CodeInternalError, "internal error", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// readyz is the readiness probe. It pings Postgres with a short timeout and
// returns 200 "ready" when the pool is reachable, or the canonical 503 envelope
// when it isn't — so orchestrators stop routing traffic to an unhealthy replica.
func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Pool().Ping(ctx); err != nil {
		s.log.Warn("readyz: database not ready", "err", err, "request_id", mw.RequestIDFromContext(r.Context()))
		writeAPIError(w, r, http.StatusServiceUnavailable, CodeServiceUnavailable, "database not ready", nil)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready"))
}

func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// ── handlers ──────────────────────────────────────────────────────────────────

type sendReq struct {
	RecipientID string `json:"recipientId"`
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
	// Optional system kind (e.g. "call_missed"); absent means an ordinary
	// message. Whitelisted below — clients cannot invent kinds.
	Kind string `json:"kind"`
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req sendReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.RecipientID) || req.Body == "" || !validUUID(req.ClientMsgID) {
		writeErr(w, http.StatusBadRequest, "recipientId, body, clientMsgId required")
		return
	}
	if req.Kind != "" && !store.ValidMessageKind(req.Kind) {
		writeErr(w, http.StatusBadRequest, "unknown message kind")
		return
	}
	res, err := s.store.SendMessage(r.Context(), claims.OrgID, claims.UserID, req.RecipientID, req.Body, req.ClientMsgID, req.Kind)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

type replyReq struct {
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
}

func (s *Server) reply(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	var req replyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Body == "" || !validUUID(req.ClientMsgID) {
		writeErr(w, http.StatusBadRequest, "body, clientMsgId required")
		return
	}
	res, err := s.store.Reply(r.Context(), claims.OrgID, claims.UserID, convID, req.Body, req.ClientMsgID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

type forwardReq struct {
	RecipientID string `json:"recipientId"`
	ClientMsgID string `json:"clientMsgId"`
}

// forwardMessage forwards the message {id} to another Bliss-Work user, recording
// provenance so the original author learns about it. Idempotent on clientMsgId.
func (s *Server) forwardMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	var req forwardReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.RecipientID) || !validUUID(req.ClientMsgID) {
		writeErr(w, http.StatusBadRequest, "recipientId, clientMsgId required")
		return
	}
	res, err := s.store.ForwardMessage(r.Context(), claims.OrgID, claims.UserID, msgID, req.RecipientID, req.ClientMsgID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// listForwards returns the downstream forward tree of message {id}. Only the
// original author may read it (the store enforces this).
func (s *Server) listForwards(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	edges, err := s.store.ListForwards(r.Context(), claims.OrgID, claims.UserID, msgID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, edges)
}

// listForwardActivity returns the caller's originals that have been forwarded.
func (s *Server) listForwardActivity(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	items, err := s.store.ListMyForwardActivity(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) ignore(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	if err := s.store.Ignore(r.Context(), claims.OrgID, claims.UserID, convID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listConversations(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convs, err := s.store.ListConversations(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, convs)
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	msgs, err := s.store.ListMessages(r.Context(), claims.OrgID, claims.UserID, convID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

type readReq struct {
	UpToSeq int64 `json:"upToSeq"`
}

func (s *Server) markRead(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	var req readReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.UpToSeq < 0 {
		writeErr(w, http.StatusBadRequest, "upToSeq must be >= 0")
		return
	}
	if err := s.store.MarkRead(r.Context(), claims.OrgID, claims.UserID, convID, req.UpToSeq); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) block(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	peerID := chi.URLParam(r, "id")
	if !validUUID(peerID) {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := s.store.Block(r.Context(), claims.OrgID, claims.UserID, peerID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) unblock(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	peerID := chi.URLParam(r, "id")
	if !validUUID(peerID) {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := s.store.Unblock(r.Context(), claims.OrgID, claims.UserID, peerID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
