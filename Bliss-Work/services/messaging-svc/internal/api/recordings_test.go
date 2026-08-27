package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/livekit"
)

// The playback route must stay outside the JWT verifier for the same reason the
// attachment one does: a <video src> cannot carry an Authorization header. If it
// is ever "tidied" under /api/v1, every recording stops playing.
func TestRecordingPlaybackIsOutsideTheAuthedGroup(t *testing.T) {
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
	for _, want := range []string{"GET /recordings/{id}", "POST /livekit/webhook"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("%s is not registered at the router root:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "GET /api/v1/recordings/{id}") {
		t.Fatal("recording playback was moved under /api/v1, where the Bearer-only " +
			"verifier will reject every <video> request")
	}
}

// The webhook is a public, unauthenticated route in the JWT sense — the SFU
// holds no account here. Its ONLY defence is the signature over the body, so an
// unsigned POST must be refused before anything in the payload is believed.
func TestLiveKitWebhookRefusesAnUnsignedPost(t *testing.T) {
	h := testRouter(t)

	body := strings.NewReader(`{"event":"egress_ended","egressInfo":{"egress_id":"EG_1"}}`)
	req := httptest.NewRequest(http.MethodPost, "/livekit/webhook", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned webhook: got %d, want 401", rec.Code)
	}
}

func testRecorder(t *testing.T, apiURL string) *livekit.Recorder {
	t.Helper()
	r, err := livekit.NewRecorder("key", "secret", "wss://sfu.test",
		livekit.RecorderOptions{APIURL: apiURL, FileRoot: "/media"})
	if err != nil {
		t.Fatalf("NewRecorder: %v", err)
	}
	return r
}

// Regression test for the race StartRoom's own doc comment describes: this is
// the NORMAL case immediately after "Start meeting" (the room does not exist
// in LiveKit yet because the host has not connected to it yet), not a rare
// failure — a single attempt lost this race under ordinary conditions.
func TestStartRoomWithRetrySucceedsOnceTheRoomExists(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		w.Header().Set("content-type", "application/json")
		if n < 3 {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"not_found","msg":"twirp error unknown: requested room does not exist"}`))
			return
		}
		_, _ = w.Write([]byte(`{"egress_id":"EG_1"}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	egressID, err := startRoomWithRetry(ctx, testRecorder(t, srv.URL), "call-123", "key")
	if err != nil {
		t.Fatalf("startRoomWithRetry: %v", err)
	}
	if egressID != "EG_1" {
		t.Errorf("egressID = %q, want EG_1", egressID)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Errorf("calls = %d, want 3 (two 404s then success)", got)
	}
}

// Any OTHER kind of failure must not be retried — it would only add latency
// to "Start meeting" for a failure retrying cannot fix.
func TestStartRoomWithRetryDoesNotRetryUnrelatedErrors(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := startRoomWithRetry(context.Background(), testRecorder(t, srv.URL), "call-123", "key")
	if err == nil {
		t.Fatal("expected an error")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("calls = %d, want exactly 1 — a non-404 error must not be retried", got)
	}
}

// The retry loop must give up once the caller's own deadline passes, rather
// than running past it waiting for a room that may never appear.
func TestStartRoomWithRetryRespectsContextDeadline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found","msg":"twirp error unknown: requested room does not exist"}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if _, err := startRoomWithRetry(ctx, testRecorder(t, srv.URL), "call-123", "key"); err == nil {
		t.Fatal("expected an error once the deadline passed")
	}
}
