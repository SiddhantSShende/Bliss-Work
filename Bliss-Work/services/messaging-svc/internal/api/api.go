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
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/livekit"
	"github.com/task-board/messaging-svc/internal/media"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// smallBody is the request-body cap for ordinary JSON endpoints (chat messages,
// member lists). Generous for text plus UUID lists, small enough that an
// oversized payload cannot be buffered into the heap as a cheap DoS.
const smallBody = 1 << 20

// livekitWebhooksPerMinute is the allowance for the SFU's callbacks.
//
// Sized for the event rate rather than for a person: LiveKit emits roughly ten
// events per participant-session (joining, leaving, and each track published
// and unpublished), so this carries a few hundred people moving in and out of
// rooms every minute. Still bounded — the route is public, and an allowance is
// what keeps an unauthenticated endpoint from being an amplifier.
const livekitWebhooksPerMinute = 3000

// Server holds handler dependencies.
type Server struct {
	store    *store.Store
	verifier *auth.Verifier
	log      *slog.Logger
	limiter  *mw.Limiter

	// Attachment plumbing: the on-disk blob store, the HMAC signer for
	// download URLs, and their configuration.
	blobs    blob.Store
	signer   *media.Signer
	mediaCfg config.MediaConfig
	mapsCfg  config.MapsConfig

	// Mints the short-lived room tokens that authorize group call media. Never
	// nil — an unconfigured Minter reports itself and every call token request
	// fails with a clear 503 rather than a nil dereference.
	livekit *livekit.Minter

	// Asks the SFU to record a call, and reads the webhook that says how it
	// went. Never nil either, and a zero one is the ordinary state: recording
	// is off unless RECORDINGS_ENABLED and an egress deployment say otherwise.
	recorder *livekit.Recorder
}

// NewServer constructs an API server.
func NewServer(
	st *store.Store,
	v *auth.Verifier,
	log *slog.Logger,
	blobs blob.Store,
	signer *media.Signer,
	mediaCfg config.MediaConfig,
	mapsCfg config.MapsConfig,
	lk *livekit.Minter,
) *Server {
	if lk == nil {
		// A zero Minter is the honest "no SFU here" state and answers
		// Configured() false, which the token handler turns into a 503.
		lk = &livekit.Minter{}
	}
	return &Server{
		store:    st,
		verifier: v,
		log:      log,
		limiter:  mw.NewLimiter(mw.DefaultLimits),
		blobs:    blobs,
		signer:   signer,
		mediaCfg: mediaCfg,
		mapsCfg:  mapsCfg,
		livekit:  lk,
		// Zero value = "this deployment does not record", which every recording
		// path checks for. WithRecorder replaces it where it does.
		recorder: &livekit.Recorder{},
	}
}

// WithRecorder turns call recording on.
//
// A method rather than a tenth constructor parameter, for the same reason
// WithSharedRateLimits is one: recording is genuinely optional, and every
// existing caller — the tests included — keeps working untouched without it.
func (s *Server) WithRecorder(rec *livekit.Recorder) *Server {
	if rec != nil {
		s.recorder = rec
	}
	return s
}

// WithSharedRateLimits makes rate limiting fleet-wide, drawing every caller's
// tokens from one Redis bucket rather than one per pod.
//
// A method rather than another constructor parameter because it is genuinely
// optional: without it the limiter behaves exactly as it always has, and every
// existing caller — including the tests — keeps working untouched.
func (s *Server) WithSharedRateLimits(store *mw.SharedStore) *Server {
	s.limiter.WithShared(store)
	return s
}

// Router builds the chi router with CORS, health, and the authed API group.
func (s *Server) Router(webOrigin string) http.Handler {
	r := chi.NewRouter()
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
		// Inbound mail from outside BlissWork. Posted by whatever terminates
		// SMTP for the deployment, in already-parsed form — see
		// store.InboundMailInput for why the contract is not raw RFC 5322.
		g.Post("/internal/mail/inbound", s.receiveInboundMail)
		// The bytes of a file attached to a sent mail, for email-worker to put
		// on the wire as a MIME part. A GET carries no body, so the MaxBytes
		// above is irrelevant to it; the RESPONSE is a whole file, bounded by
		// the upload cap that let it exist and by what the relay agrees to ask
		// for in the first place.
		g.Get("/internal/mail/{mailId}/attachments/{id}", s.internalMailAttachment)
		// DEK rotation for messagingdb's org_keys. Ops / incident-response only;
		// mirrors auth-svc's POST /internal/keys/rotate/{org_id} — rotate every
		// service's copy to fully rotate an org.
		g.Post("/internal/keys/rotate/{orgId}", s.rotateOrgDEK)
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
		// A call recording, on the same terms and for the same reason: a
		// <video src> cannot carry an Authorization header.
		g.Get("/recordings/{id}", s.downloadRecording)
	})

	// ── LiveKit webhook ──────────────────────────────────────────────────────
	// The SFU reporting what happened in a room, and how a recording finished.
	// Outside /api/v1 because LiveKit holds no BlissWork account and cannot
	// present our JWT; what authenticates it is a signature over the body,
	// checked before the payload is parsed. Body-capped like every other route
	// with a body.
	//
	// On its OWN rate-limit budget rather than the per-IP default. This used to
	// carry one event per recording, which is rare; it now also carries every
	// participant and track event in every room, which is not — and all of it
	// arrives from the single source address of the SFU. Left on the ordinary
	// browser-sized allowance, a busy hour would start answering 429 to
	// `participant_left`, and a dropped departure is exactly the bug this route
	// was extended to fix: somebody shown as being in a meeting they have left.
	r.Group(func(g chi.Router) {
		g.Use(s.limiter.PerIPBudget("livekit", livekitWebhooksPerMinute))
		g.Use(mw.MaxBytes(smallBody))
		g.Post("/livekit/webhook", s.livekitWebhook)
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
			// Open-or-create with no message, so "message this person" can
			// navigate to an empty thread instead of sending a fake greeting.
			r.Post("/conversations", s.openConversation)
			r.Get("/conversations", s.listConversations)
			r.Post("/conversations/{id}/reply", s.reply)
			r.Post("/conversations/{id}/ignore", s.ignore)
			r.Post("/conversations/{id}/clear", s.clearConversation)
			r.Get("/conversations/{id}/messages", s.listMessages)
			r.Get("/conversations/{id}/reactions", s.listConversationReactions)
			r.Post("/conversations/{id}/read", s.markRead)

			// Reactions. Same URL under two verbs, so a double-tap is
			// idempotent at the HTTP layer and not only in SQL.
			r.Put("/messages/{id}/reactions/{emoji}", s.setReaction)
			r.Delete("/messages/{id}/reactions/{emoji}", s.setReaction)
			r.Post("/users/{id}/block", s.block)
			r.Delete("/users/{id}/block", s.unblock)

			// ── Calls ────────────────────────────────────────────────────
			// Channel calls: scheduled, members-only, and deliberately with
			// no invite route — being in the channel IS the invitation.
			r.Post("/channels/{id}/calls", s.scheduleChannelCall)
			r.Get("/channels/{id}/calls", s.listChannelCalls)

			// Meetings: an explicit roster, so a link means something.
			r.Post("/meetings", s.scheduleMeeting)
			r.Post("/calls/{id}/invites", s.createCallInvite)
			r.Delete("/calls/{id}/invites/{inviteId}", s.revokeCallInvite)
			// The ONE cross-org door in this service. Not under /calls/{id}
			// on purpose: the caller cannot name a call they cannot yet see,
			// so the token in the body is the whole request.
			r.Post("/calls/join", s.joinCallByToken)

			r.Post("/calls/direct", s.startDirectCall)
			// Who is busy right now. Registered BEFORE /calls/{id} so chi
			// cannot read the literal "on-call" as a call id — the same
			// ordering rule the channel roster route carries a note about.
			r.Get("/calls/on-call", s.onCallUsers)
			r.Get("/calls", s.listMyCalls)
			r.Get("/calls/{id}", s.getCall)
			r.Post("/calls/{id}/participants", s.addCallParticipant)
			// POST, not GET: this mints a short-lived credential for the SFU
			// and re-decides access from the database every time, so it must
			// never be cached or prefetched. Answers 202 with the waiting
			// room, and no token, for a call that has not started.
			r.Post("/calls/{id}/token", s.callToken)
			// Opens a scheduled call and admits everyone waiting on it. The
			// authority to do this is narrow (host / org admin / channel
			// owner or admin) and is what the waiting room waits for.
			r.Post("/calls/{id}/start", s.startCall)
			// Screen sharing. The stop route takes no target — it can only
			// ever stop the CALLER's own share, which is how "the stop
			// control belongs to the sharer" is enforced rather than merely
			// rendered.
			r.Post("/calls/{id}/share", s.startScreenShare)
			r.Post("/calls/{id}/share/stop", s.stopScreenShare)
			r.Post("/calls/{id}/leave", s.leaveCall)
			r.Post("/calls/{id}/end", s.endCall)
			// The recording of a finished call, if it has one and this caller
			// may see it. Answers a short-lived signed link rather than the
			// bytes; the bytes are at /recordings/{id} below.
			r.Get("/calls/{id}/recording", s.getCallRecording)
			// Starting and stopping one by hand, from inside the room. HOSTS
			// ONLY (AuthorizeRecordingControl), and both are POST — see the
			// note on stopCallRecording for why the stop is not a DELETE.
			r.Post("/calls/{id}/recording/start", s.startCallRecording)
			r.Post("/calls/{id}/recording/stop", s.stopCallRecording)

			// Attachment metadata routes — small JSON, so they stay behind the
			// 1 MiB cap (and, at the edge, behind the WAF) unlike the upload.
			r.Post("/attachments/{id}/commit", s.commitAttachment)
			r.Post("/attachments/links", s.attachmentLinks)

			// Static map thumbnails for shared locations. Proxied server-side so
			// the image is same-origin, the user's IP never reaches the provider
			// and the API key stays off the client. Returns 204 when unavailable.
			r.Get("/maps/static", s.staticMap)
			// Names a coordinate so a shared location reads as a place rather
			// than "Shared location", and resolves a coarse position by IP for
			// desktops whose browser geolocation has no provider to ask. Both
			// answer 204 when the feature is not configured.
			r.Get("/maps/reverse", s.reverseGeocode)
			r.Get("/maps/whereami", s.whereami)

			// Deep link (wa.me): records the forward and writes the system
			// entry, but sends nothing — the client opens WhatsApp itself.
			// Needs no connected Business account, so it is available to every
			// authenticated org member. Idempotent on clientMsgId, so it stays
			// out of the idempotency group.
			r.Post("/messages/{id}/forward-link", s.forwardLink)

			// Forward INSIDE the workspace, to a chat or a channel. Unlike the
			// deep link this one delivers: it writes the clone, re-scopes the
			// attachments it carries so the recipient can actually open them,
			// and records the provenance edge in the same transaction.
			// Idempotent on clientMsgId, so it stays out of the idempotency
			// group for the same reason forward-link does.
			r.Post("/messages/{id}/forward", s.forwardMessage)

			r.Post("/channels", s.createChannel)
			r.Get("/channels", s.listChannels)
			r.Get("/channels/open", s.listOpenChannels)
			r.Patch("/channels/{id}", s.renameChannel)
			r.Delete("/channels/{id}", s.deleteChannel)
			r.Get("/channels/{id}/messages", s.listChannelMessages)
			r.Post("/channels/{id}/messages", s.sendChannelMessage)
			r.Get("/channels/{id}/members", s.listChannelMembers)
			r.Post("/channels/{id}/members", s.addChannelMembers)
			r.Post("/channels/{id}/join", s.joinChannel)
			r.Post("/channels/{id}/leave", s.leaveChannel)
			r.Post("/channels/{id}/clear", s.clearChannel)
			// Read receipts. `/read` moves the caller's own cursor, `/receipts`
			// reads everybody's back — the same split the DM side has between
			// POST /conversations/{id}/read and the `status` on each message.
			r.Post("/channels/{id}/read", s.markChannelRead)
			r.Get("/channels/{id}/receipts", s.listChannelReadReceipts)
			// Moderation. `/members/roster` is registered BEFORE the
			// `/members/{userId}` routes so chi does not treat the literal
			// "roster" as a user id — same registration-order rule the
			// app-credentials routes rely on in integrations-svc.
			r.Get("/channels/{id}/members/roster", s.channelRoster)
			r.Delete("/channels/{id}/members/{userId}", s.kickChannelMember)
			r.Patch("/channels/{id}/members/{userId}", s.setChannelRole)
			r.Post("/channels/{id}/blocks/{userId}", s.blockChannelMember)
			r.Delete("/channels/{id}/blocks/{userId}", s.unblockChannelMember)

			// Per-message actions inside a channel. Same shapes as their DM
			// twins above; see api/channel_message_actions.go for why the
			// prefix is `/channel-messages/` rather than `/channels/messages/`.
			r.Get("/channels/{id}/reactions", s.listChannelReactions)
			r.Put("/channel-messages/{id}/reactions/{emoji}", s.setChannelReaction)
			r.Delete("/channel-messages/{id}/reactions/{emoji}", s.setChannelReaction)
			r.Put("/channel-messages/{id}/pin", s.pinChannelMessage)
			r.Delete("/channel-messages/{id}/pin", s.pinChannelMessage)

			// ── Phase 3: unified inbox + email-style threads ───────────────
			r.Get("/inbox", s.listInbox)
			r.Get("/inbox/peers", s.listInboxPeers)

			// ── Mail ───────────────────────────────────────────────────────
			// There is deliberately no GET /mail list endpoint: a mailbox
			// listing is exactly what GET /inbox already serves (item_kind
			// MAIL), keyset-paginated with unread rollups. Adding a second,
			// parallel list would mean two pagination models over one feed.
			// The Drafts folder is the one mailbox listing GET /inbox cannot
			// serve: a draft is in nobody's feed (see listMailDrafts).
			r.Get("/mail/drafts", s.listMailDrafts)
			r.Post("/mail/drafts", s.createMailDraft)
			r.Patch("/mail/drafts/{id}", s.saveMailDraft)
			r.Delete("/mail/drafts/{id}", s.discardMailDraft)
			r.Delete("/mail/drafts/{id}/attachments/{attachmentId}", s.removeDraftAttachment)
			r.Get("/mail/{id}", s.getMail)
			r.Get("/threads/{id}", s.getThread)
			r.Get("/threads/{id}/messages", s.listThreadMessages)
			r.Post("/threads/{id}/reply", s.replyToThread)

			// Idempotent state-mutators (no natural client_msg_id).
			r.Group(func(g chi.Router) {
				g.Use(idempotency)
				g.Post("/threads/{id}/ignore", s.ignoreThread)
				g.Post("/threads/{id}/read", s.readThread)
				g.Post("/messages/{id}/dismiss", s.dismissMessage)
				// Two different acts: hide is one reader's view, delete is the
				// message itself and only its author may do it.
				g.Post("/messages/{id}/hide", s.hideMessage)
				g.Delete("/messages/{id}", s.deleteMessage)
				// The channel twins. Same two acts, different table and a
				// wider set of people allowed to perform the second.
				g.Post("/channel-messages/{id}/hide", s.hideChannelMessage)
				g.Delete("/channel-messages/{id}", s.deleteChannelMessage)
				g.Post("/inbox/items/{kind}/{refId}/ignore", s.ignoreInboxItem)
				// The undo of the line above, for the Deleted Items folder.
				g.Post("/inbox/items/{kind}/{refId}/restore", s.restoreInboxItem)
				g.Post("/inbox/items/{kind}/{refId}/read", s.markInboxItemRead)
				// Send has no natural client-supplied id, and a double-tap on a
				// slow connection must not fan a mail out twice.
				g.Post("/mail/drafts/{id}/send", s.sendMail)
				g.Post("/mail/{id}/read", s.markMailRead)
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
		writeAPIError(w, r, code, httpStatusToCode(code), msg)
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
		writeAPIError(w, r, status, code, msg)
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
				writeAPIError(w, r, http.StatusInternalServerError, CodeInternalError, "internal error")
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
		writeAPIError(w, r, http.StatusServiceUnavailable, CodeServiceUnavailable, "database not ready")
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready"))
}

func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// MaxMessageBodyBytes bounds a single chat message.
//
// ── Why a message needs a size at all ────────────────────────────────────────
// This used to be unbounded: every send site checked `body == ""` and nothing
// else, so the only ceiling was smallBody (1 MiB) on the whole request. A body
// is not just stored — it is copied into an outbox row, published as a Kafka
// message, and then written into the replay ZSET of EVERY recipient. So one
// number decided the size of four different things, and it was a megabyte.
//
// Three failures came out of that, and they are all the same root cause:
//
//   - Kafka rejects a message over ~1 MiB. The producer fails the whole write
//     BEFORE sending anything, the outbox marks nothing published, and the next
//     tick re-claims the same head-of-queue row — forever. One message could
//     permanently stop every event in the platform. (The poller now quarantines
//     such a row rather than retrying it, but not producing one is the fix.)
//   - The replay outbox stores the full event per recipient against a Redis
//     with `noeviction`, so a large body times a large channel could fill the
//     instance — taking presence, the node registry and the shared rate-limit
//     buckets down with it.
//   - Every copy is durable: the outbox row, the Kafka log and 7 days of Redis.
//
// ── Why 8 KiB ────────────────────────────────────────────────────────────────
// Sized from what a chat message IS, not from what a request can carry. Slack
// caps a message at 4,000 characters; 8 KiB is comfortably above that even for
// multi-byte scripts, and it makes the worst case arithmetic knowable: a
// 10,000-member channel message costs ~90 MB of Redis rather than ~10 GB, and
// no single event can approach the broker limit.
//
// Counted in BYTES, not runes, because bytes are what Kafka, Postgres and Redis
// actually pay for — a rune limit would let a message of astral-plane
// characters cost four times its stated size.
//
// Attachments are the answer for anything larger, and they already exist: they
// stream to object storage and travel as a reference rather than as an event
// payload.
const MaxMessageBodyBytes = 8 << 10

// validMessageBody reports whether a body is present and within the cap.
// Every send path must use this — see maxbody_test.go, which enumerates the
// routes and fails when a new one forgets.
func validMessageBody(s string) bool {
	return s != "" && len(s) <= MaxMessageBodyBytes
}

// errBodyTooLong is the shared 400 for an over-cap body. One message, so the
// client can show the same thing wherever the send came from.
const errBodyTooLong = "message body exceeds 8192 bytes"

// ── handlers ──────────────────────────────────────────────────────────────────

type sendReq struct {
	RecipientID string `json:"recipientId"`
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
	// Optional system kind (e.g. "call_missed"); absent means an ordinary
	// message. Whitelisted below — clients cannot invent kinds.
	Kind string `json:"kind"`
	// Which surface is sending: "chat" (default) or "mail". Only the Compose
	// dialog sends "mail", and only mail threads reach the Inbox.
	Origin string `json:"origin"`
	// Message being quoted, if any.
	ReplyToID string `json:"replyToId"`
}

type openConversationReq struct {
	PeerID string `json:"peerId"`
}

// openConversation opens the 1:1 conversation with `peerId` WITHOUT sending
// anything, so "message this person" can navigate straight to an empty thread.
// See store.OpenConversation for why the app previously had to send a greeting.
func (s *Server) openConversation(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req openConversationReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.PeerID) {
		writeErr(w, http.StatusBadRequest, "peerId required")
		return
	}
	if req.PeerID == claims.UserID {
		writeErr(w, http.StatusBadRequest, "cannot open a conversation with yourself")
		return
	}
	convID, err := s.store.OpenConversation(r.Context(), claims.OrgID, claims.UserID, req.PeerID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	// 200, not 201: the conversation may well have already existed, and the
	// caller cannot tell the difference (nor should it care).
	writeJSON(w, http.StatusOK, map[string]string{"conversationId": convID})
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
	if !validMessageBody(req.Body) {
		writeErr(w, http.StatusBadRequest, errBodyTooLong)
		return
	}
	if req.Kind != "" && !store.ValidMessageKind(req.Kind) {
		writeErr(w, http.StatusBadRequest, "unknown message kind")
		return
	}
	// Whitelisted, like Kind: the origin decides whether this thread appears in
	// the Inbox, so a client must not be able to invent a third value.
	if req.Origin != "" && !store.ValidThreadOrigin(req.Origin) {
		writeErr(w, http.StatusBadRequest, "unknown origin")
		return
	}
	if req.ReplyToID != "" && !validUUID(req.ReplyToID) {
		writeErr(w, http.StatusBadRequest, "invalid replyToId")
		return
	}
	res, err := s.store.SendMessage(r.Context(), claims.OrgID, claims.UserID, req.RecipientID, req.Body, req.ClientMsgID,
		store.SendOptions{Kind: req.Kind, Origin: req.Origin, ReplyToID: req.ReplyToID})
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

type replyReq struct {
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
	// Message being quoted, if any. A reply always inherits its thread's origin,
	// so there is nothing to declare here.
	ReplyToID string `json:"replyToId"`
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
	if !validMessageBody(req.Body) {
		writeErr(w, http.StatusBadRequest, errBodyTooLong)
		return
	}
	if req.ReplyToID != "" && !validUUID(req.ReplyToID) {
		writeErr(w, http.StatusBadRequest, "invalid replyToId")
		return
	}
	res, err := s.store.Reply(r.Context(), claims.OrgID, claims.UserID, convID, req.Body, req.ClientMsgID, req.ReplyToID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
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

func (s *Server) clearConversation(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	if err := s.store.ClearConversation(r.Context(), claims.OrgID, claims.UserID, convID); err != nil {
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

// listMessages serves GET /api/v1/conversations/{id}/messages?beforeSeq=&limit=.
//
// Returns one page ascending by seq. Omitting beforeSeq gives the newest page;
// pass the lowest seq you hold to walk backwards through history. A short page
// (fewer rows than limit) means you have reached the beginning.
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	beforeSeq, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
	msgs, err := s.store.ListMessages(r.Context(), claims.OrgID, claims.UserID, convID, beforeSeq, limit)
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
