package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestSecurityHeaders_SetsAllExpectedHeaders is the headers contract test. The
// frontend doesn't depend on these directly — browsers do — so if we drop one
// silently, no UI test would catch it. This test catches it.
func TestSecurityHeaders_SetsAllExpectedHeaders(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := SecurityHeaders(mux)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	want := []struct {
		key      string
		contains string
	}{
		{"Strict-Transport-Security", "max-age=31536000"},
		{"X-Content-Type-Options", "nosniff"},
		{"X-Frame-Options", "DENY"},
		{"Referrer-Policy", "strict-origin-when-cross-origin"},
		{"Permissions-Policy", "camera="},
		{"Content-Security-Policy", "frame-ancestors 'none'"},
	}
	for _, w := range want {
		got := rr.Header().Get(w.key)
		if got == "" {
			t.Errorf("missing header %q", w.key)
			continue
		}
		if !contains(got, w.contains) {
			t.Errorf("header %q = %q; want it to contain %q", w.key, got, w.contains)
		}
	}
}

// TestSecurityHeaders_DoesNotOverrideExisting ensures handlers can opt out of a
// specific header by setting it themselves before the response is flushed.
// Today nothing does, but the property protects future use cases like a route
// that needs a relaxed CSP for a sandboxed iframe.
func TestSecurityHeaders_DoesNotOverrideExisting(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.WriteHeader(http.StatusOK)
	})
	h := SecurityHeaders(mux)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if got := rr.Header().Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Errorf("handler-set X-Frame-Options was overridden: got %q", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
