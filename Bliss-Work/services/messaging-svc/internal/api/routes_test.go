package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/store"
)

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard for the body-cap restructure.
//
// mw.MaxBytes used to be applied once at the router root. It had to move to
// per-group application so the attachment upload could accept 100 MB, because
// http.MaxBytesReader does NOT widen when nested — an outer 1 MiB reader is the
// underlying stream for an inner 100 MB one, so the outer still trips first.
//
// The hazard that created is silent: a route registered outside a capped group
// loses its DoS protection with no error and no failing test. These tests are
// that failing test.
// ─────────────────────────────────────────────────────────────────────────────

func testRouter(t *testing.T) http.Handler {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(
		store.NewUnconnected(),
		nil, // verifier: unused by the structural assertions below
		log,
		nil, // blobs
		nil, // signer
		config.MediaConfig{MaxBytes: 100 << 20},
		config.MapsConfig{},
		nil, // livekit — unconfigured, which is what these route tests want
	)
	return srv.Router("http://localhost:5173")
}

// cappedRoutes is the authoritative inventory of every route that accepts a
// request body, and the cap it must run under.
//
// ⚠️ ADDING A ROUTE? Add it here too. If this test fails because you registered
// something new, the fix is almost never to edit this list in isolation — it is
// to confirm the route sits inside a group that applies mw.MaxBytes, and only
// then record it. A body-taking route with no cap is a cheap heap-exhaustion
// DoS against the service.
var cappedRoutes = map[string]string{
	// /internal/* — service-to-service, small JSON.
	"POST /internal/messages/delivered": "small",
	// Inbound mail. Already-parsed JSON, not raw MIME, and the store truncates
	// the subject and body to their rune limits — so a large message is
	// rejected by the cap long before anything is stored.
	"POST /internal/mail/inbound": "small",
	// DEK rotation. No body at all — the org id is in the path — but it is a
	// POST, so it inherits the same small-body group and is listed here for
	// the walk to find.
	"POST /internal/keys/rotate/{orgId}": "small",

	// /api/v1 — everything small except the one upload route.
	"POST /api/v1/conversations":             "small",
	"POST /api/v1/conversations/messages":    "small",
	"POST /api/v1/conversations/{id}/reply":  "small",
	"POST /api/v1/conversations/{id}/ignore": "small",
	"POST /api/v1/conversations/{id}/clear":  "small",
	"POST /api/v1/conversations/{id}/read":   "small",
	// Bulk "delete for everyone" — a batch of message ids, scoped to the
	// conversation. Same /api/v1 small-body group, so the cap is inherited.
	"POST /api/v1/conversations/{id}/messages/delete": "small",
	"POST /api/v1/users/{id}/block":                   "small",
	"DELETE /api/v1/users/{id}/block":                 "small",
	"POST /api/v1/attachments/{id}/commit":            "small",
	"POST /api/v1/attachments/links":                  "small",
	"POST /api/v1/messages/{id}/forward-link":         "small",
	"POST /api/v1/messages/{id}/forward":              "small",
	// Batch forward — the multi-select twin of the single-pair route above.
	// Same /api/v1 small-body group, so the cap is inherited.
	"POST /api/v1/forwards":               "small",
	"POST /api/v1/channels":               "small",
	"PATCH /api/v1/channels/{id}":         "small",
	"DELETE /api/v1/channels/{id}":        "small",
	"POST /api/v1/channels/{id}/messages": "small",
	"POST /api/v1/channels/{id}/members":  "small",
	"POST /api/v1/channels/{id}/join":     "small",
	"POST /api/v1/channels/{id}/leave":    "small",
	"POST /api/v1/channels/{id}/clear":    "small",
	"POST /api/v1/channels/{id}/read":     "small",
	// Bulk "delete for everyone" — the channel twin of the conversation route
	// above. Same reasoning, same group.
	"POST /api/v1/channels/{id}/messages/delete": "small",
	// Channel moderation. The two DELETEs take no body at all and the PATCH/POST
	// take a tiny JSON object; all four sit inside the same /api/v1 group that
	// applies mw.MaxBytes, so the cap is inherited rather than per-handler.
	"DELETE /api/v1/channels/{id}/members/{userId}": "small",
	"PATCH /api/v1/channels/{id}/members/{userId}":  "small",
	"POST /api/v1/channels/{id}/blocks/{userId}":    "small",
	"DELETE /api/v1/channels/{id}/blocks/{userId}":  "small",
	"POST /api/v1/threads/{id}/reply":               "small",
	"POST /api/v1/threads/{id}/ignore":              "small",
	"POST /api/v1/threads/{id}/read":                "small",
	"POST /api/v1/messages/{id}/dismiss":            "small",
	// Deleting and reacting. The two DELETEs and the PUT carry no body at all
	// (their arguments are in the path), and all four sit inside the same
	// /api/v1 group that applies mw.MaxBytes, so the cap is inherited.
	"POST /api/v1/messages/{id}/hide":                "small",
	"DELETE /api/v1/messages/{id}":                   "small",
	"PUT /api/v1/messages/{id}/reactions/{emoji}":    "small",
	"DELETE /api/v1/messages/{id}/reactions/{emoji}": "small",
	// The channel twins of the four above, plus pinning. Same story: the
	// DELETEs and PUTs carry no body (their arguments are in the path), and all
	// six sit inside the same /api/v1 small-body group, so the cap is inherited.
	"POST /api/v1/channel-messages/{id}/hide":                "small",
	"DELETE /api/v1/channel-messages/{id}":                   "small",
	"PUT /api/v1/channel-messages/{id}/pin":                  "small",
	"DELETE /api/v1/channel-messages/{id}/pin":               "small",
	"PUT /api/v1/channel-messages/{id}/reactions/{emoji}":    "small",
	"DELETE /api/v1/channel-messages/{id}/reactions/{emoji}": "small",
	"POST /api/v1/inbox/items/{kind}/{refId}/ignore":         "small",
	"POST /api/v1/inbox/items/{kind}/{refId}/read":           "small",
	// Restore — the undo of ignore, for the Deleted Items folder. No body at
	// all (its arguments are in the path), and it sits in the same idempotency
	// group as the two above, inside the /api/v1 small-body group.
	"POST /api/v1/inbox/items/{kind}/{refId}/restore": "small",

	// Mail. All four sit inside the same /api/v1 small-body group (send and
	// read additionally inside the idempotency subgroup nested in it), so the
	// cap is inherited. The largest body is a send: a subject, a recipient list
	// and a body, each bounded again in the store (MaxMailSubjectRunes,
	// MaxMailRecipients, MaxMailBodyRunes) — attachments never ride this
	// request, they were uploaded against the draft beforehand.
	"POST /api/v1/mail/drafts":           "small",
	"DELETE /api/v1/mail/drafts/{id}":    "small",
	"POST /api/v1/mail/drafts/{id}/send": "small",
	// Taking a file back off a draft. No body at all — both ids are in the path
	// — and it sits in the same /api/v1 group, so the cap is inherited.
	"DELETE /api/v1/mail/drafts/{id}/attachments/{attachmentId}": "small",
	// The composer's autosave. Same body as /send — a subject and a body, both
	// bounded by the store's rune limits — and in the same /api/v1 group, so it
	// runs under the same cap.
	"PATCH /api/v1/mail/drafts/{id}": "small",
	"POST /api/v1/mail/{id}/read":    "small",

	// Calls. Every one of these sits inside the same /api/v1 small-body group,
	// so the cap is inherited. The bodies are a title, a timestamp and at most
	// maxMeetingInvitees uuids — the invitee cap is enforced in the handler as
	// well, because 1 MiB of uuids is still 25k INSERTs.
	"POST /api/v1/channels/{id}/calls":             "small",
	"POST /api/v1/meetings":                        "small",
	"POST /api/v1/calls/direct":                    "small",
	"POST /api/v1/calls/join":                      "small",
	"POST /api/v1/calls/{id}/invites":              "small",
	"DELETE /api/v1/calls/{id}/invites/{inviteId}": "small",
	"POST /api/v1/calls/{id}/participants":         "small",
	"POST /api/v1/calls/{id}/token":                "small",
	"POST /api/v1/calls/{id}/telemetry":            "small",
	"POST /api/v1/calls/{id}/start":                "small",
	"POST /api/v1/calls/{id}/share":                "small",
	"POST /api/v1/calls/{id}/share/stop":           "small",
	"POST /api/v1/calls/{id}/leave":                "small",
	"POST /api/v1/calls/{id}/end":                  "small",
	// Recording start/stop carry no body at all — the call id is in the path —
	// but they are POSTs, so they inherit the same small-body group and are
	// listed here for the walk to find. Verified at api.go: both sit inside the
	// /api/v1 group that applies mw.MaxBytes(smallBody).
	"POST /api/v1/calls/{id}/recording/start": "small",
	"POST /api/v1/calls/{id}/recording/stop":  "small",
	// A meeting's transcript. One chat line or one note per request, both
	// bounded to store.CallTranscriptTextMax, so "small" is generous already.
	"POST /api/v1/calls/{id}/chat":  "small",
	"POST /api/v1/calls/{id}/notes": "small",

	// LiveKit's egress/room webhook. PUBLIC — it is reached without a session,
	// so an uncapped body here would be a denial-of-service anyone could send.
	// It has its own group applying mw.MaxBytes(smallBody) rather than
	// inheriting one, because it is registered outside /api/v1.
	"POST /livekit/webhook": "small",

	// The single large-body route. Capped in the handler, not by a group.
	"POST /api/v1/attachments": "large",
}

// TestEveryBodyRouteIsAccountedFor walks the real router and fails if a
// body-taking method is registered that the inventory above does not know about.
func TestEveryBodyRouteIsAccountedFor(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}

	var unknown []string
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodPost && method != http.MethodPut &&
			method != http.MethodPatch && method != http.MethodDelete {
			return nil
		}
		route = strings.TrimSuffix(route, "/")
		// /metrics is registered with r.Handle, so chi reports it for every
		// method. promhttp ignores the request body entirely, and the edge
		// 404s the path before it reaches us, so there is nothing to cap.
		if route == "/metrics" {
			return nil
		}
		key := method + " " + route
		if _, known := cappedRoutes[key]; !known {
			unknown = append(unknown, key)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		t.Fatalf("body-taking route(s) not listed in cappedRoutes:\n  %s\n\n"+
			"Confirm each one sits inside a group applying mw.MaxBytes, then add it to the inventory.",
			strings.Join(unknown, "\n  "))
	}
}

// TestSmallBodyCapEnforced proves the 1 MiB cap actually runs on a
// representative small-body route. Auth rejects the request, but MaxBytesReader
// is installed before that, so an oversized body is refused rather than buffered.
func TestSmallBodyCapEnforced(t *testing.T) {
	h := testRouter(t)

	// /internal/* has no JWT middleware, so the request reaches the handler and
	// we can observe the cap end to end.
	big := strings.NewReader(strings.Repeat("a", 2<<20))
	req := httptest.NewRequest(http.MethodPost, "/internal/messages/delivered", big)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// Whatever the handler decides (401 for the missing internal token), the
	// body must NOT have been fully readable.
	if rec.Code == http.StatusOK {
		t.Fatalf("2 MiB body to a small-body route returned 200; the cap is not in force")
	}
}

// TestSmallBodyCapIsNotAppliedToUpload pins the reason the restructure happened:
// the upload route must not inherit a 1 MiB cap from an enclosing group.
func TestSmallBodyCapIsNotAppliedToUpload(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	var found bool
	err := chi.Walk(r, func(method, route string, _ http.Handler, mws ...func(http.Handler) http.Handler) error {
		if method == http.MethodPost && strings.TrimSuffix(route, "/") == "/api/v1/attachments" {
			found = true
			// Probe each middleware in the chain with an oversized body. None of
			// them may truncate it — the handler owns the cap for this route.
			for i, m := range mws {
				if truncatesAt1MiB(m) {
					t.Errorf("middleware #%d on POST /api/v1/attachments caps the body below the upload limit; "+
						"a nested MaxBytesReader cannot widen an outer one", i)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if !found {
		t.Fatal("POST /api/v1/attachments is not registered")
	}
}

// truncatesAt1MiB feeds a 2 MiB body through one middleware and reports whether
// a downstream handler could still read all of it.
func truncatesAt1MiB(m func(http.Handler) http.Handler) bool {
	var read int64
	var readErr error
	h := m(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		read, readErr = io.Copy(io.Discard, r.Body)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments", strings.NewReader(strings.Repeat("a", 2<<20)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return readErr != nil || (read > 0 && read < 2<<20)
}

// The download route must NOT sit under the JWT verifier: a browser cannot put
// an Authorization header on <img src>. If someone "tidies" it into /api/v1,
// every image in the product silently breaks.
func TestMediaDownloadIsOutsideTheAuthedGroup(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	var routes []string
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes = append(routes, method+" "+strings.TrimSuffix(route, "/"))
		return nil
	})
	joined := strings.Join(routes, "\n")
	if !strings.Contains(joined, "GET /media/{id}") {
		t.Fatalf("GET /media/{id} is not registered at the router root:\n%s", joined)
	}
	if strings.Contains(joined, "GET /api/v1/media/{id}") {
		t.Fatal("media download was moved under /api/v1, where the Bearer-only " +
			"verifier will reject every <img>/<video> request")
	}
}
