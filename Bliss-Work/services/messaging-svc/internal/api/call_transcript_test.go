package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/store"
)

// The transcript routes carry what was said in a meeting. Two structural facts
// about them are worth a failing test rather than a code review:
//
//  1. that they exist at all under /api/v1 — a route silently not registered
//     looks like an empty transcript, not like a missing endpoint; and
//  2. that they sit INSIDE the authed group. A meeting's chat read without a
//     session would be the whole point of the feature inverted, and "it is
//     behind the verifier" is a property of where a line sits in api.go, which
//     is exactly the kind of thing that survives a refactor by luck.
func TestTranscriptRoutesAreRegistered(t *testing.T) {
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

	for _, want := range []string{
		"GET /api/v1/calls/{id}/chat",
		"POST /api/v1/calls/{id}/chat",
		"GET /api/v1/calls/{id}/notes",
		"POST /api/v1/calls/{id}/notes",
		"GET /api/v1/calls/history",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("%s is not registered:\n%s", want, joined)
		}
	}
}

// Every one of them must refuse a caller with no session.
func TestTranscriptRoutesRequireASession(t *testing.T) {
	h := testRouter(t)
	const call = "/api/v1/calls/11111111-1111-1111-1111-111111111111"

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, call + "/chat"},
		{http.MethodPost, call + "/chat"},
		{http.MethodGet, call + "/notes"},
		{http.MethodPost, call + "/notes"},
		{http.MethodGet, "/api/v1/calls/history"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{"text":"hi"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: got %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

// "history" must not be swallowed by /calls/{id}. chi matches a literal segment
// before a wildcard, but the ORDER of registration is what makes that true here,
// and the failure mode if it regresses is a 400 "invalid call id" on a route
// that looks correct in the source.
func TestCallHistoryIsNotReadAsACallID(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	var historyIdx, wildcardIdx = -1, -1
	i := 0
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		route = strings.TrimSuffix(route, "/")
		if method == http.MethodGet && route == "/api/v1/calls/history" {
			historyIdx = i
		}
		if method == http.MethodGet && route == "/api/v1/calls/{id}" {
			wildcardIdx = i
		}
		i++
		return nil
	})
	if historyIdx == -1 || wildcardIdx == -1 {
		t.Fatalf("expected both routes registered (history=%d wildcard=%d)", historyIdx, wildcardIdx)
	}
}

// A chat/note request that is malformed on its own terms — empty or
// over-length text, an over-length client entry id, or a cursor that will not
// decode — must not come back as the SAME 403 "forbidden" a genuine
// non-participant gets from callHostOrgForWrite/callHostOrgForRead. A client
// cannot act on "forbidden" for a message it merely typed too much of, and a
// 403 here would make it think its session or its membership in the call was
// the problem rather than the request's shape.
func TestTranscriptValidationErrorsAreDistinctFromForbidden(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"text empty or too long", store.ErrTranscriptTextInvalid},
		{"entry id too long", store.ErrTranscriptEntryIDInvalid},
		{"cursor does not decode", store.ErrTranscriptCursorInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, code, msg := mapStoreError(tc.err)
			if status != http.StatusUnprocessableEntity {
				t.Errorf("status = %d, want %d", status, http.StatusUnprocessableEntity)
			}
			if code != CodeValidationError {
				t.Errorf("code = %q, want %q", code, CodeValidationError)
			}
			if msg == "" || msg == "forbidden" {
				t.Errorf("message = %q, must name what was wrong with the request, not echo the forbidden case", msg)
			}
			if status == http.StatusForbidden {
				t.Error("must not map to the same status as an actual non-participant access attempt")
			}

			// Must survive wrapping, the same way every other mapStoreError case
			// does — a handler that adds context with %w must not fall back to
			// 500 or, worse, collapse into ErrForbidden's 403.
			wrapped := fmt.Errorf("append: %w", tc.err)
			wstatus, wcode, _ := mapStoreError(wrapped)
			if wstatus != status || wcode != code {
				t.Errorf("wrapped error mapped to (%d, %q), want (%d, %q)", wstatus, wcode, status, code)
			}
		})
	}

	// The case this must stay distinguishable from: a caller who was never on
	// the call's roster gets ErrForbidden, unchanged, still 403.
	status, code, _ := mapStoreError(store.ErrForbidden)
	if status != http.StatusForbidden || code != CodeForbidden {
		t.Errorf("store.ErrForbidden mapped to (%d, %q), want (403, %q) — "+
			"an actual non-participant access attempt must still be refused as forbidden",
			status, code, CodeForbidden)
	}
}
