package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// GET /internal/calls/blocked must refuse a request with no X-Internal-Token
// at all — the same fail-closed contract every other /internal/* route in
// this package already carries (see TestLiveKitWebhookRefusesAnUnsignedPost).
// No store access happens on this path (internalAuthOK runs first), so
// testRouter's unconnected store is sufficient — no database needed.
func TestInternalCallsBlockedRefusesMissingToken(t *testing.T) {
	h := testRouter(t)

	req := httptest.NewRequest(http.MethodGet,
		"/internal/calls/blocked?orgId=00000000-0000-7000-8000-000000000001"+
			"&userA=00000000-0000-7000-8000-000000000002"+
			"&userB=00000000-0000-7000-8000-000000000003", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d, want 401", rec.Code)
	}
}

// A present-but-wrong token must be refused too, not merely an absent one —
// otherwise the check would be "is the header set" rather than "is the
// header correct."
func TestInternalCallsBlockedRefusesWrongToken(t *testing.T) {
	h := testRouter(t)

	req := httptest.NewRequest(http.MethodGet,
		"/internal/calls/blocked?orgId=00000000-0000-7000-8000-000000000001"+
			"&userA=00000000-0000-7000-8000-000000000002"+
			"&userB=00000000-0000-7000-8000-000000000003", nil)
	req.Header.Set("X-Internal-Token", "definitely-not-the-real-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: got %d, want 401", rec.Code)
	}
}

// Route must not be reachable at all without SOME token — confirms the
// endpoint fails closed even for a well-formed request that is otherwise
// entirely valid (real-shaped UUIDs, right method, right path).
func TestInternalCallsBlockedNeverReachesTheStoreWithoutAuth(t *testing.T) {
	h := testRouter(t) // store.NewUnconnected() — any real query would panic/error

	req := httptest.NewRequest(http.MethodGet, "/internal/calls/blocked", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token and missing params: got %d, want 401 "+
			"(auth must be checked before parameter validation, so this must "+
			"still be 401 and not 400)", rec.Code)
	}
}
