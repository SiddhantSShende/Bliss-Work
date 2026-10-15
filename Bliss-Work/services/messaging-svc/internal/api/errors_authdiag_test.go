// errors_authdiag_test.go — the TEMPORARY "authdiag" log mapErrR emits on a
// 403, added for the "conversation reply / channel message / reaction
// returns 403 Forbidden" investigation. mapStoreError's store.ErrForbidden
// case is the only branch that ever produces http.StatusForbidden, so this
// pins down the one chokepoint for every such 403 across the service — for
// each of the endpoints the original report named (reply, channel message
// retrieval, and both conversation/channel reaction list+set routes, all
// switched from mapErr(w, err) to mapErrR(w, r, err)) — and that it never
// fires for an unrelated error (which would turn ordinary 404s etc. into log
// noise) or logs anything beyond method/path/request_id/status.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

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

// serveThroughMapErrR drives err through the real mw.RequestID middleware
// (so rid comes from the exact context path production requests take) and
// straight into mapErrR, bypassing the store entirely.
func serveThroughMapErrR(s *Server, err error, method, path, clientRequestID string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	if clientRequestID != "" {
		req.Header.Set(mw.HeaderRequestID, clientRequestID)
	}
	mw.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mapErrR(w, r, err)
	})).ServeHTTP(rr, req)
	return rr
}

// One case per handler switched from mapErr(w, err) to mapErrR(w, r, err) for
// this investigation: the conversation-reply endpoint (previous turn) plus
// the channel-message-retrieval and conversation/channel-reaction endpoints
// (this turn) the original report also named. Each handler's error path is a
// single `s.mapErrR(w, r, err)` call with its own `r` parameter in scope —
// Go's lexical scoping makes it impossible for that to resolve to any request
// other than the one the handler itself received, so what is actually worth
// pinning down per-route is mapErrR's behavior for each one's real method and
// path shape, not a reimplementation of the store's membership checks.
func TestMapErrR_ForbiddenDiagLogsRouteAndRequestID(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
	}{
		{"conversation reply", http.MethodPost, "/api/v1/conversations/c1/reply"},
		{"channel message retrieval", http.MethodGet, "/api/v1/channels/ch1/messages"},
		{"conversation reactions list", http.MethodGet, "/api/v1/conversations/c1/reactions"},
		{"channel reactions list", http.MethodGet, "/api/v1/channels/ch1/reactions"},
		// r.URL.Path is percent-DECODED by net/http, so the emoji appears
		// literally here too — matching what a real request would log.
		{"set conversation-message reaction", http.MethodPut, "/api/v1/messages/m1/reactions/👍"},
		{"set channel-message reaction", http.MethodDelete, "/api/v1/channel-messages/m1/reactions/👍"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			capture := &captureHandler{}
			s := &Server{log: slog.New(capture)}
			reqID := "diag-403-" + tc.name

			rr := serveThroughMapErrR(s, store.ErrForbidden, tc.method, tc.path, reqID)

			if rr.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403", rr.Code)
			}
			var body struct {
				Error struct {
					Code      string `json:"code"`
					RequestID string `json:"requestId"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode response body: %v", err)
			}
			if body.Error.Code != "forbidden" {
				t.Errorf("error.code = %q, want %q", body.Error.Code, "forbidden")
			}
			if body.Error.RequestID != reqID {
				t.Errorf("error.requestId = %q, want the client-supplied id echoed back", body.Error.RequestID)
			}

			var diag []map[string]any
			for _, rec := range capture.records {
				if rec["msg"] == "authdiag" {
					diag = append(diag, rec)
				}
			}
			if len(diag) != 1 {
				t.Fatalf("got %d authdiag records, want exactly 1 (records=%v)", len(diag), capture.records)
			}
			rec := diag[0]
			if rec["method"] != tc.method {
				t.Errorf("method = %v, want %s", rec["method"], tc.method)
			}
			if rec["path"] != tc.path {
				t.Errorf("path = %v, want %q (the request's actual path, carrying the real resource id)", rec["path"], tc.path)
			}
			if rec["request_id"] != reqID {
				t.Errorf("request_id = %v, want the same id the response body carried (%q)", rec["request_id"], reqID)
			}
			// slog.Any(int) round-trips as int64, not int — see Value.Any's doc.
			if rec["status"] != int64(403) {
				t.Errorf("status = %v (%T), want int64(403)", rec["status"], rec["status"])
			}
			// The whole point of gating on status==403 rather than logging the
			// error itself: no store error's message (which can quote caller
			// input, e.g. ErrMailInvalidAddress) ever reaches this log line.
			if _, hasErr := rec["err"]; hasErr {
				t.Errorf("authdiag record carries an \"err\" field — it must only ever log method/path/request_id/status, got %v", rec)
			}
		})
	}
}

func TestMapErrR_NonForbiddenErrorDoesNotEmitAuthdiag(t *testing.T) {
	capture := &captureHandler{}
	s := &Server{log: slog.New(capture)}

	rr := serveThroughMapErrR(s, store.ErrNotFound, http.MethodGet, "/api/v1/conversations/c1/reactions", "diag-404-1")

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
	for _, rec := range capture.records {
		if rec["msg"] == "authdiag" {
			t.Fatalf("authdiag logged for a non-403 error — it must only fire on store.ErrForbidden, got %v", rec)
		}
	}
}
