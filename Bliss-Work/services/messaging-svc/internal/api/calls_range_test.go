package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The calendar read. Three structural facts about it are worth a failing test
// rather than a code review, and they are the same three the transcript routes
// carry (see call_transcript_test.go):
//
//  1. that it is registered at all — an unregistered calendar endpoint looks
//     like a week with no meetings in it, not like a missing route;
//  2. that it sits INSIDE the authed group; and
//  3. that "range" is not swallowed by /calls/{id}, which is a property of the
//     ORDER of two lines in api.go and would otherwise regress into a 400
//     "invalid call id" on a route that reads correctly in the source.
func TestCallRangeRouteIsRegistered(t *testing.T) {
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
	if !strings.Contains(joined, "GET /api/v1/calls/range") {
		t.Fatalf("GET /api/v1/calls/range is not registered:\n%s", joined)
	}
}

func TestCallRangeRequiresASession(t *testing.T) {
	h := testRouter(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/calls/range?from=2026-09-01T00:00:00Z&to=2026-09-08T00:00:00Z", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("GET /calls/range without a session: got %d, want 401", rec.Code)
	}
}

// "range" must be matched as a literal, not read as a call id. chi prefers a
// literal segment over a wildcard, but both routes have to be registered for
// that preference to have anything to choose between.
func TestCallRangeIsNotReadAsACallID(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	var haveRange, haveWildcard bool
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		route = strings.TrimSuffix(route, "/")
		if method == http.MethodGet && route == "/api/v1/calls/range" {
			haveRange = true
		}
		if method == http.MethodGet && route == "/api/v1/calls/{id}" {
			haveWildcard = true
		}
		return nil
	})
	if !haveRange || !haveWildcard {
		t.Fatalf("expected both routes registered (range=%v wildcard=%v)", haveRange, haveWildcard)
	}
}
