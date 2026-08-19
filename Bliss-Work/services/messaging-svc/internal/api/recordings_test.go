package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
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
