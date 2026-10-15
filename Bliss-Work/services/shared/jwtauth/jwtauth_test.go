// jwtauth_test.go — Middleware's behavior on a missing/malformed Authorization
// header, and the TEMPORARY authdiag log added for the "missing bearer token"
// investigation (messaging channel/reaction/conversation requests 401ing
// while others on the same page succeed).
//
// Captures slog output via a custom handler rather than asserting on stdout
// text, so this stays correct if the log format changes. The one thing it
// must never do — log the raw bearer token — is asserted explicitly.
package jwtauth

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureHandler is a minimal slog.Handler that records each record's
// message and attributes, keyed by attribute name, for simple assertions.
type captureHandler struct {
	records []map[string]any
}

func (c *captureHandler) Enabled(context.Context, slog.Level) bool { return true }
func (c *captureHandler) WithAttrs(attrs []slog.Attr) slog.Handler { return c }
func (c *captureHandler) WithGroup(string) slog.Handler            { return c }
func (c *captureHandler) Handle(_ context.Context, r slog.Record) error {
	m := map[string]any{"msg": r.Message}
	r.Attrs(func(a slog.Attr) bool {
		m[a.Key] = a.Value.Any()
		return true
	})
	c.records = append(c.records, m)
	return nil
}

func withCapturedLogs(t *testing.T, fn func()) *captureHandler {
	t.Helper()
	h := &captureHandler{}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })
	fn()
	return h
}

func noopNext() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
}

func TestMiddleware_MissingBearerToken_401sAndDiagLogsNoToken(t *testing.T) {
	v := &Verifier{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/c1/messages", nil)
	req.Header.Set("X-Request-Id", "diag-req-1")
	// No Authorization header at all — the exact reported symptom.
	rec := httptest.NewRecorder()

	logs := withCapturedLogs(t, func() {
		v.Middleware(noopNext()).ServeHTTP(rec, req)
	})

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	// http.Error appends a trailing newline.
	if got := strings.TrimSpace(rec.Body.String()); got != `{"error":"missing bearer token"}` {
		t.Fatalf("body = %q, want the literal missing-bearer-token message", got)
	}

	if len(logs.records) != 1 {
		t.Fatalf("got %d authdiag log records, want exactly 1", len(logs.records))
	}
	rec0 := logs.records[0]
	if rec0["bearer_present"] != false {
		t.Errorf("bearer_present = %v, want false", rec0["bearer_present"])
	}
	if rec0["request_id"] != "diag-req-1" {
		t.Errorf("request_id = %v, want the client-supplied X-Request-Id to be echoed into the log", rec0["request_id"])
	}
	if rec0["path"] != "/api/v1/channels/c1/messages" {
		t.Errorf("path = %v, want the request path", rec0["path"])
	}
}

// TestMiddleware_NeverLogsTheRawToken is the hard constraint from the
// investigation's instructions: whatever the diagnostic logs, the token
// itself — valid, expired, or malformed — must never appear in it.
func TestMiddleware_NeverLogsTheRawToken(t *testing.T) {
	// A real JWKS endpoint with no matching key, so a well-formed-looking
	// Bearer value fails verification through the ordinary parse() error path
	// (not a panic on a zero-value Verifier's nil cache) — the branch that
	// must not log `raw`/`authz`.
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"keys":[]}`))
	}))
	t.Cleanup(jwks.Close)
	v, err := NewVerifier(context.Background(), jwks.URL, "test-issuer")
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	const secretLookingToken = "super-secret-jwt-value-must-never-be-logged"

	cases := []struct {
		name  string
		authz string
	}{
		{"missing entirely", ""},
		{"malformed (no Bearer prefix)", secretLookingToken},
		{"well-formed but unverifiable (no matching JWKS key)", "Bearer " + secretLookingToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/api/v1/messages/m1/reactions/%F0%9F%91%8D", nil)
			if tc.authz != "" {
				req.Header.Set("Authorization", tc.authz)
			}
			req.Header.Set("X-Request-Id", "diag-req-2")
			rec := httptest.NewRecorder()

			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
			t.Cleanup(func() { slog.SetDefault(prev) })

			v.Middleware(noopNext()).ServeHTTP(rec, req)

			if strings.Contains(buf.String(), secretLookingToken) {
				t.Fatalf("authdiag log leaked the token value: %s", buf.String())
			}
		})
	}
}
