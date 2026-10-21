package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

// ── Test harness ──────────────────────────────────────────────────────────────
//
// These tests exercise the real handleWS -> serveConn -> readLoop/writeLoop
// path end to end (real JWT verification against a locally-served JWKS, real
// websocket.Accept/Dial, real Redis for presence/replay) rather than mocking
// pieces of it, because the behavior under test — whether the connection
// survives past the point where a request-scoped context would have killed it
// — is precisely the kind of thing a narrower unit test could accidentally
// verify against the wrong mechanism.
//
// Redis: point WS_GATEWAY_TEST_REDIS_URL at a disposable instance (e.g.
// `docker run --rm -p 16379:6379 redis:7-alpine`, which is what these tests
// default to). Tests skip if it is unreachable rather than failing the suite.

func testRedisURL() string {
	if v := os.Getenv("WS_GATEWAY_TEST_REDIS_URL"); v != "" {
		return v
	}
	return "redis://127.0.0.1:16379/0"
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.New(testRedisURL())
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := st.Ping(ctx); err != nil {
		t.Skipf("test redis unreachable at %s (set WS_GATEWAY_TEST_REDIS_URL): %v", testRedisURL(), err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// testAuth mints real, verifiable JWTs against a locally-served JWKS so
// verifier.Verify runs the exact same EdDSA/JWKS-cache code path production
// does — the only difference from auth-svc is which key signed the token.
type testAuth struct {
	verifier *auth.Verifier
	priv     jwk.Key
	srv      *httptest.Server
}

func newTestAuth(t *testing.T) *testAuth {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	const kid = "test-key-1"

	pubKey, err := jwk.FromRaw(pub)
	if err != nil {
		t.Fatalf("jwk.FromRaw(pub): %v", err)
	}
	_ = pubKey.Set(jwk.KeyIDKey, kid)
	_ = pubKey.Set(jwk.AlgorithmKey, jwa.EdDSA)

	privKey, err := jwk.FromRaw(priv)
	if err != nil {
		t.Fatalf("jwk.FromRaw(priv): %v", err)
	}
	_ = privKey.Set(jwk.KeyIDKey, kid)
	_ = privKey.Set(jwk.AlgorithmKey, jwa.EdDSA)

	set := jwk.NewSet()
	if err := set.AddKey(pubKey); err != nil {
		t.Fatalf("AddKey: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(set)
	})
	srv := httptest.NewServer(mux)

	verifier, err := auth.NewVerifier(context.Background(), srv.URL+"/.well-known/jwks.json", "task-board")
	if err != nil {
		srv.Close()
		t.Fatalf("auth.NewVerifier: %v", err)
	}

	return &testAuth{verifier: verifier, priv: privKey, srv: srv}
}

func (ta *testAuth) close() { ta.srv.Close() }

// mint signs a token shaped like the ones auth-svc issues: sub, org_id,
// username, sid, and a memberships list containing (at least) the caller's
// own org/user pair, matching what auth.normalizeMemberships expects.
func (ta *testAuth) mint(t *testing.T, userID, orgID, sessionID string, ttl time.Duration) string {
	t.Helper()
	tok, err := jwt.NewBuilder().
		Subject(userID).
		Issuer("task-board").
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(ttl)).
		Claim("org_id", orgID).
		Claim("username", "test-user").
		Claim("sid", sessionID).
		Claim("memberships", []map[string]string{{"o": orgID, "u": userID}}).
		Build()
	if err != nil {
		t.Fatalf("build token: %v", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, ta.priv))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return string(signed)
}

// testServer wires a real Server (real hub, real Redis-backed store, real
// JWT verification) behind an httptest.Server, exactly like main.go does
// minus the Kafka/delivery/signal/presence wiring (all nil, which the rest
// of the codebase already treats as an optional-in-tests dependency).
type testServer struct {
	srv  *Server
	hub  *hub.Hub
	auth *testAuth
	ts   *httptest.Server
}

func newTestServer(t *testing.T, rootCtx context.Context) *testServer {
	t.Helper()
	st := newTestStore(t)
	ta := newTestAuth(t)
	h := hub.New()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	srv := New(Config{
		WebOrigin:       "http://localhost:5173",
		MaxConnections:  0,
		MaxConnsPerUser: 0,
	}, ta.verifier, h, st, nil, nil, nil, nil, "test-node", log, rootCtx)

	ts := httptest.NewServer(srv.Handler())

	t.Cleanup(func() {
		ta.close()
		ts.Close()
	})

	return &testServer{srv: srv, hub: h, auth: ta, ts: ts}
}

func (ts *testServer) wsURL() string {
	return "ws" + ts.ts.URL[len("http"):] + "/ws"
}

// dial opens a real websocket.Conn against the test server using a freshly
// minted token, and returns it plus the connID assigned to it (via a fresh
// UUID caller-side is not possible — conn IDs are server-assigned — so tests
// that need to target one connection by ID instead assert via observable
// behavior: hub counts, message exchange, or which of several sockets closes).
func (ts *testServer) dial(t *testing.T, ctx context.Context, token string) *websocket.Conn {
	t.Helper()
	// A real browser always sends an Origin header; set it to the server's
	// configured WebOrigin so these tests exercise the same allowed path a
	// legitimate client takes. Origin-specific allow/reject behavior itself
	// is covered separately by origin_e2e_test.go.
	c, _, err := websocket.Dial(ctx, ts.wsURL()+"?token="+token, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

// readUntil reads frames from c until one decodes to a JSON object whose
// "type" field equals want, or ctx is done. Intermediate frames of other
// types are discarded, matching how a real client ignores frames it doesn't
// care about.
func readUntil(t *testing.T, ctx context.Context, c *websocket.Conn, want string) map[string]any {
	t.Helper()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read (waiting for %q): %v", want, err)
		}
		var frame map[string]any
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}
		if frame["type"] == want {
			return frame
		}
	}
}

func send(t *testing.T, ctx context.Context, c *websocket.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// drainInBackground continuously reads c until it errors (including a clean
// close), then closes the returned channel. coder/websocket requires a
// connection to always be read from or control frames (including Close) are
// never processed (see the library's own doc comment on Conn) — a server
// that initiates a close performs a real close handshake and will otherwise
// block for up to 5s per connection waiting for a peer response that never
// comes. A real client is always reading; tests that don't need to inspect
// specific frames use this instead, exactly as a real client's read loop
// would behave.
func drainInBackground(c *websocket.Conn) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	return done
}

func waitClosed(t *testing.T, done <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatal("timed out waiting for connection to close")
	}
}

func waitForHubCount(t *testing.T, h *hub.Hub, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if h.Count() == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("hub count = %d, want %d after %s", h.Count(), want, timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestHandleWS_SurvivesPastHandlerReturn is the context-regression test the
// investigation specifically called for: it would fail if the detached
// connection's parent context were r.Context() instead of s.rootCtx, because
// r.Context() is documented (net/http) to be canceled the instant ServeHTTP
// returns — which, in the detached design, happens within microseconds of
// the connection being established, long before this test's sleep elapses.
func TestHandleWS_SurvivesPastHandlerReturn(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)
	c := ts.dial(t, ctx, token)
	defer c.Close(websocket.StatusNormalClosure, "")

	// By the time Dial() returns, the HTTP round-trip that upgraded this
	// connection has already completed — meaning handleWS (and therefore
	// ServeHTTP) has already returned, and any request-scoped context tied to
	// it has already been canceled by net/http. If serveConn's parent were
	// r.Context(), the connection would already be on its way down right now.
	//
	// Sleep well past any immediate-cancellation bug (which would manifest in
	// well under a millisecond) but far short of any legitimate timeout
	// (pingTimeout/writeTimeout are 10s) so this test is neither flaky nor slow.
	time.Sleep(500 * time.Millisecond)

	// Prove the connection is still fully live, not merely "not yet observed
	// as closed": round-trip an actual client frame through handleClientFrame.
	send(t, ctx, c, map[string]string{"type": "ping"})
	frame := readUntil(t, ctx, c, "pong")
	if frame["type"] != "pong" {
		t.Fatalf("got %v, want pong", frame)
	}
}

// TestHandleWS_HelloReadyReplayFlow verifies the connect-time catch-up burst
// (ready, then replay.done) still completes correctly on the detached path.
func TestHandleWS_HelloReadyReplayFlow(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	userID, orgID := uuid.NewString(), uuid.NewString()
	token := ta.mint(t, userID, orgID, uuid.NewString(), time.Minute)
	c := ts.dial(t, ctx, token)
	defer c.Close(websocket.StatusNormalClosure, "")

	send(t, ctx, c, map[string]string{"type": "hello"})

	ready := readUntil(t, ctx, c, "ready")
	if ready["userId"] != userID {
		t.Errorf("ready.userId = %v, want %v", ready["userId"], userID)
	}
	if ready["orgId"] != orgID {
		t.Errorf("ready.orgId = %v, want %v", ready["orgId"], orgID)
	}

	// No presence broadcaster is configured (nil in newTestServer), so no
	// presence snapshot frame is sent — the next frame in the burst is
	// replay.done directly (an empty replay for a brand-new user).
	readUntil(t, ctx, c, "replay.done")
}

// TestHandleWS_NormalClientClose verifies a client-initiated close still
// deregisters the connection from the hub (proving serveConn's defer cleanup
// still runs correctly on the detached goroutine).
func TestHandleWS_NormalClientClose(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)
	c := ts.dial(t, ctx, token)

	waitForHubCount(t, ts.hub, 1, time.Second)

	if err := c.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("client close: %v", err)
	}

	waitForHubCount(t, ts.hub, 0, time.Second)
}

// TestHandleWS_HubCloseAllClosesDetachedConnections verifies the server's
// actual shutdown mechanism (hub.CloseAll, called from main.go before
// httpServer.Shutdown) still tears down connections whose readLoop now runs
// on a detached goroutine rather than the original HTTP handler goroutine.
func TestHandleWS_HubCloseAllClosesDetachedConnections(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const n = 5
	conns := make([]*websocket.Conn, n)
	closed := make([]<-chan struct{}, n)
	for i := 0; i < n; i++ {
		token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)
		conns[i] = ts.dial(t, ctx, token)
		// Draining in the background from the moment of connect, like a real
		// client, is what lets the server's close handshake (see
		// drainInBackground's doc comment) complete promptly instead of
		// stalling for its full 5s per-connection timeout.
		closed[i] = drainInBackground(conns[i])
	}
	defer func() {
		for _, c := range conns {
			_ = c.Close(websocket.StatusNormalClosure, "")
		}
	}()

	waitForHubCount(t, ts.hub, n, time.Second)

	ts.hub.CloseAll()

	waitForHubCount(t, ts.hub, 0, time.Second)

	// Each client should observe its socket actually closing, not just the
	// hub forgetting about it.
	for i, done := range closed {
		t.Run(fmt.Sprintf("conn-%d", i), func(t *testing.T) {
			waitClosed(t, done, 2*time.Second)
		})
	}
}

// TestHandleWS_CloseSession verifies session-scoped revocation (used when a
// refresh-token family is revoked — see internal/revoke) still targets the
// right connection by SessionID after detaching, and leaves unrelated
// connections (including a second connection for the SAME user under a
// DIFFERENT session) untouched.
func TestHandleWS_CloseSession(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	userID, orgID := uuid.NewString(), uuid.NewString()
	sessionA, sessionB := uuid.NewString(), uuid.NewString()

	tokenA := ta.mint(t, userID, orgID, sessionA, time.Minute)
	tokenB := ta.mint(t, userID, orgID, sessionB, time.Minute)
	connA := ts.dial(t, ctx, tokenA)
	connB := ts.dial(t, ctx, tokenB)
	defer func() { _ = connB.Close(websocket.StatusNormalClosure, "") }()

	// connA is expected to be closed by the server below; drain it in the
	// background like a real client so the server's close handshake (see
	// drainInBackground) completes promptly. connB is deliberately NOT
	// drained here — the test reads its pong explicitly further down, and a
	// background drainer would race that read.
	connAClosed := drainInBackground(connA)

	waitForHubCount(t, ts.hub, 2, time.Second)

	closed := ts.hub.CloseSession(userID, sessionA)
	if closed != 1 {
		t.Fatalf("CloseSession closed %d connections, want 1", closed)
	}

	waitForHubCount(t, ts.hub, 1, time.Second)
	waitClosed(t, connAClosed, 2*time.Second)

	// Session B must be unaffected: still open and still functional.
	send(t, ctx, connB, map[string]string{"type": "ping"})
	readUntil(t, ctx, connB, "pong")
}

// TestHandleWS_NoGoroutineLeak connects and disconnects repeatedly and
// confirms goroutine count returns to baseline each time — the detached
// design still creates exactly the same 3 goroutines/connection as before
// (see the forensic investigation) and must still release all 3 on close.
func TestHandleWS_NoGoroutineLeak(t *testing.T) {
	ts := newTestServer(t, context.Background())
	ta := ts.auth

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	baseline := goroutineCountSettled()

	for i := 0; i < 10; i++ {
		token := ta.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)
		c := ts.dial(t, ctx, token)
		waitForHubCount(t, ts.hub, 1, time.Second)
		if err := c.Close(websocket.StatusNormalClosure, ""); err != nil {
			t.Fatalf("close %d: %v", i, err)
		}
		waitForHubCount(t, ts.hub, 0, time.Second)
	}

	after := goroutineCountSettled()
	// Allow a small margin: background goroutines (GC, timers) can be
	// transiently up by one or two independent of this test's connections.
	if after > baseline+3 {
		t.Errorf("goroutine count after 10 connect/close cycles = %d, baseline = %d (leak suspected)", after, baseline)
	}
}

// goroutineCountSettled samples runtime.NumGoroutine() after giving any
// just-closed connections' goroutines a moment to actually exit (Close()
// unblocking a read/write is not synchronous with the goroutine returning).
func goroutineCountSettled() int {
	time.Sleep(100 * time.Millisecond)
	runtime.GC()
	return runtime.NumGoroutine()
}
