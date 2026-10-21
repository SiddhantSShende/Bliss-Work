package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// TestHandleWS_RejectsDisallowedOrigin proves the WS upgrade itself enforces
// isAllowedOrigin — not just the plain-HTTP cors() middleware — by dialing
// with a valid token but a disallowed Origin header and confirming the
// upgrade never completes (the dial fails with a non-101 status), rather
// than silently falling back to InsecureSkipVerify's old "accept anything"
// behavior.
func TestHandleWS_RejectsDisallowedOrigin(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)

	_, resp, err := websocket.Dial(ctx, ts.wsURL()+"?token="+token, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://evil.com"}},
	})
	if err == nil {
		t.Fatal("expected dial to fail for a disallowed Origin, it succeeded")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

// TestHandleWS_AcceptsAllowedOrigin is the control for the above: the exact
// same server, with the configured WebOrigin, must still accept connections
// normally, confirming the new check doesn't break legitimate clients.
func TestHandleWS_AcceptsAllowedOrigin(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)

	c, _, err := websocket.Dial(ctx, ts.wsURL()+"?token="+token, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}},
	})
	if err != nil {
		t.Fatalf("dial with allowed origin: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")
}

// TestHandleWS_AcceptsElectronOrigin confirms the documented, narrow
// Electron carve-out (no HTTP origin to send) still connects even against a
// server configured for a production https:// WebOrigin.
func TestHandleWS_AcceptsElectronOrigin(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)

	c, _, err := websocket.Dial(ctx, ts.wsURL()+"?token="+token, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"null"}},
	})
	if err != nil {
		t.Fatalf("dial with electron null origin: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")
}
