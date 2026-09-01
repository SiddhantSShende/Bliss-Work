package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/delivery"
	"github.com/task-board/ws-gateway/internal/hub"
	rtcsignal "github.com/task-board/ws-gateway/internal/signal"
	"github.com/task-board/ws-gateway/internal/store"
)

// discardLog is a logger that swallows output so tests stay quiet.
func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// drainSend non-destructively collects every frame currently buffered on the
// conn's Send channel, decoding each into a map and returning the "type"
// values in order. It never blocks: it stops at the first empty read.
func drainSendTypes(t *testing.T, conn *hub.Conn) []string {
	t.Helper()
	var types []string
	for {
		select {
		case raw := <-conn.Send:
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatalf("frame is not JSON object: %v (%s)", err, raw)
			}
			ty, _ := m["type"].(string)
			types = append(types, ty)
		default:
			return types
		}
	}
}

// newTestServer builds a Server with just the dependencies a given frame path
// needs. store may be nil for paths that never touch it (ping / unknown).
func newTestServer(st *store.Store, d *delivery.Dispatcher) *Server {
	return newTestServerWithSignal(st, d, nil)
}

// newTestServerWithSignal is newTestServer plus a signal.Dispatcher, for
// exercising handleCallFrame / handleSignalingFrame end to end (those return
// immediately when s.signal is nil).
func newTestServerWithSignal(st *store.Store, d *delivery.Dispatcher, sig *rtcsignal.Dispatcher) *Server {
	return &Server{
		store:      st,
		dispatcher: d,
		signal:     sig,
		log:        discardLog(),
	}
}

// fakePresenceChecker answers the same-org online question from a controlled
// table — the server-package twin of signal package's own fakeChecker, needed
// here because unexported test types cannot cross a package boundary.
type fakePresenceChecker struct{ online map[string]bool }

func (f *fakePresenceChecker) IsOnlineInOrg(_ context.Context, orgID, userID string) (bool, error) {
	return f.online[orgID+"\x00"+userID], nil
}

// fakeBlockChecker answers the block question from a controlled table,
// checked in both orderings — mirroring how messaging-svc's bool_or(blocked)
// rule treats a block from either side as blocking both directions.
type fakeBlockChecker struct{ blocked map[string]bool }

func (f *fakeBlockChecker) IsBlocked(_ context.Context, _ string, userA, userB string) (bool, error) {
	return f.blocked[userA+"\x00"+userB] || f.blocked[userB+"\x00"+userA], nil
}

func testSession() *session {
	sess := &session{}
	sess.claims.Store(&auth.Claims{UserID: "u-sender", OrgID: "org-1"})
	return sess
}

func TestHandleClientFrame_Routing(t *testing.T) {
	tests := []struct {
		name      string
		frame     string
		wantTypes []string // frame "type" values expected on conn.Send, in order
	}{
		{
			name:      "ping enqueues a single pong",
			frame:     `{"type":"ping"}`,
			wantTypes: []string{"pong"},
		},
		{
			name:      "unknown type is ignored",
			frame:     `{"type":"definitely-not-a-real-frame"}`,
			wantTypes: nil,
		},
		{
			name:      "subscribe is ignored (implicit fan-out)",
			frame:     `{"type":"subscribe"}`,
			wantTypes: nil,
		},
		{
			name:      "malformed json is dropped without enqueue",
			frame:     `{not json`,
			wantTypes: nil,
		},
		{
			// onHello always enqueues "ready" first. Replay then runs against a
			// store whose Redis is unreachable, so it errors out (no panic) and
			// no further frames are appended.
			name:      "hello enqueues ready before catch-up replay",
			frame:     `{"type":"hello","lastSeenSeq":0}`,
			wantTypes: []string{"ready"},
		},
		{
			// nil dispatcher => message.ack is a guarded no-op (must not panic).
			name:      "message.ack with nil dispatcher is a no-op",
			frame:     `{"type":"message.ack","messageIds":["m1","m2"]}`,
			wantTypes: nil,
		},
	}

	// A store whose Redis address is unreachable: New() is lazy so it does not
	// dial, and Replay() returns an error (rather than panicking) when used.
	st, err := store.New("redis://127.0.0.1:1/0")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestServer(st, nil)
			conn := hub.NewConn("u-sender", "c1")
			s.handleClientFrame(context.Background(), conn, testSession(), []byte(tc.frame))

			got := drainSendTypes(t, conn)
			if len(got) != len(tc.wantTypes) {
				t.Fatalf("enqueued types = %v, want %v", got, tc.wantTypes)
			}
			for i := range tc.wantTypes {
				if got[i] != tc.wantTypes[i] {
					t.Fatalf("frame[%d] = %q, want %q (all: %v)", i, got[i], tc.wantTypes[i], got)
				}
			}
		})
	}
}

// TestHandleClientFrame_AckTruncatedToMaxBatch feeds an over-sized message.ack
// (more ids than maxAckBatch) and asserts the dispatcher only ever sees the
// first maxAckBatch ids. A real delivery.Dispatcher is pointed at a test HTTP
// server so we can count exactly which ids are forwarded.
func TestHandleClientFrame_AckTruncatedToMaxBatch(t *testing.T) {
	var (
		mu   sync.Mutex
		seen = map[string]struct{}{}
		done = make(chan struct{}, 1)
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MessageIDs []string `json:"messageIds"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		for _, id := range body.MessageIDs {
			seen[id] = struct{}{}
		}
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		select {
		case done <- struct{}{}:
		default:
		}
	}))
	defer srv.Close()

	d := delivery.New(srv.URL, "", discardLog())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.Run(ctx)

	s := newTestServer(nil, d)
	conn := hub.NewConn("u-sender", "c1")

	// Build an ack frame with more ids than the per-frame cap.
	overCount := maxAckBatch + 36
	ids := make([]string, overCount)
	for i := range ids {
		ids[i] = "m" + itoa(i)
	}
	frame := clientFrame{Type: "message.ack", MessageIDs: ids}
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}

	s.handleClientFrame(ctx, conn, testSession(), raw)

	// Wait for the batch to flush (Run uses a 500ms window; allow margin).
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("dispatcher never POSTed the batch")
	}
	// A second tick can carry a stragglers; give the loop a moment to settle.
	cancel()
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	got := len(seen)
	// Every id forwarded must be one of the first maxAckBatch ids.
	allowed := map[string]struct{}{}
	for i := 0; i < maxAckBatch; i++ {
		allowed["m"+itoa(i)] = struct{}{}
	}
	var leaked []string
	for id := range seen {
		if _, ok := allowed[id]; !ok {
			leaked = append(leaked, id)
		}
	}
	mu.Unlock()

	if len(leaked) > 0 {
		t.Fatalf("ids beyond maxAckBatch were forwarded: %v", leaked)
	}
	if got != maxAckBatch {
		t.Fatalf("forwarded %d ids, want exactly maxAckBatch=%d", got, maxAckBatch)
	}
}

// TestCallFrameFor_StampsCallerNameFromClaims guards the incoming-call screen:
// without a name on the wire the callee can only show a placeholder. The name
// must come from the verified JWT — a client that puts its own "fromName" on
// the frame must not be able to ring someone under a borrowed identity.
func TestCallFrameFor_StampsCallerNameFromClaims(t *testing.T) {
	var f clientFrame
	raw := `{"type":"call.invite","toUserId":"u-callee","callId":"c-1","media":"video","fromName":"ceo"}`
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	sess := &session{}
	sess.claims.Store(&auth.Claims{UserID: "u-sender", OrgID: "org-1", Username: "alice"})
	got := callFrameFor(sess, &f)

	if got.FromName != "alice" {
		t.Fatalf("FromName = %q, want the claims username %q (spoofed value was %q)", got.FromName, "alice", "ceo")
	}
	if got.CallID != "c-1" || got.Media != "video" || got.Type != "call.invite" {
		t.Fatalf("call fields not copied: %+v", got)
	}
	// toUserId is stripped by Dispatcher.Forward, so it must not ride along here.
	if got.ToUserID != "" {
		t.Fatalf("ToUserID = %q, want empty", got.ToUserID)
	}

	out, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(out, &wire); err != nil {
		t.Fatalf("unmarshal wire: %v", err)
	}
	if wire["fromName"] != "alice" {
		t.Fatalf("wire fromName = %v, want alice (%s)", wire["fromName"], out)
	}
}

// ── handleCallFrame block enforcement (P0-A) ──────────────────────────────────
//
// These exercise the WS layer end to end, over an already-registered live hub
// connection for both sender and target — the actual authorization boundary
// for a 1:1 ring (see CallInviteAllowed's doc comment on the signal package):
// CreateDirectCall's history write is best-effort and unawaited, so this is
// where a blocked caller's invite is actually stopped, or would leak through
// if it were not.

func callInviteFrame(toUserID, callID string) []byte {
	raw, _ := json.Marshal(clientFrame{Type: "call.invite", ToUserID: toUserID, CallID: callID, Media: "video"})
	return raw
}

// Test 4: a blocked caller's call.invite must never reach the target's socket.
func TestHandleCallFrame_BlockedCallerInviteNeverReachesTarget(t *testing.T) {
	h := hub.New()
	presence := &fakePresenceChecker{online: map[string]bool{"org-1\x00u-target": true}}
	blocks := &fakeBlockChecker{blocked: map[string]bool{"u-sender\x00u-target": true}}
	sig := rtcsignal.New(h, presence, blocks, nil, discardLog())
	s := newTestServerWithSignal(nil, nil, sig)

	target := hub.NewConn("u-target", "c-target")
	h.Add(target, 0, 0)
	caller := hub.NewConn("u-sender", "c-sender")
	h.Add(caller, 0, 0)

	s.handleClientFrame(context.Background(), caller, testSession(), callInviteFrame("u-target", "call-1"))

	if got := drainSendTypes(t, target); len(got) != 0 {
		t.Fatalf("target socket received frames from a blocked caller: %v", got)
	}
}

// Test 5: the same assertion, but proving it's not merely "offline" doing the
// work — the target is genuinely connected and would receive a call.invite
// from an unblocked sender (see the next test), so a live WebSocket
// connection alone is not enough to bypass the block.
func TestHandleCallFrame_ExistingConnectionCannotBypassBlock(t *testing.T) {
	h := hub.New()
	presence := &fakePresenceChecker{online: map[string]bool{"org-1\x00u-target": true}}
	blocks := &fakeBlockChecker{blocked: map[string]bool{"u-sender\x00u-target": true}}
	sig := rtcsignal.New(h, presence, blocks, nil, discardLog())
	s := newTestServerWithSignal(nil, nil, sig)

	target := hub.NewConn("u-target", "c-target")
	h.Add(target, 0, 0)
	caller := hub.NewConn("u-sender", "c-sender")
	h.Add(caller, 0, 0)

	s.handleClientFrame(context.Background(), caller, testSession(), callInviteFrame("u-target", "call-1"))

	// The caller is told the same "offline" reason a genuinely unreachable
	// peer gets — never that they are blocked — and the target hears nothing.
	callerFrames := drainSendTypes(t, caller)
	if len(callerFrames) != 1 || callerFrames[0] != "rtc.peer.unreachable" {
		t.Fatalf("caller frames = %v, want exactly one rtc.peer.unreachable", callerFrames)
	}
	if got := drainSendTypes(t, target); len(got) != 0 {
		t.Fatalf("target received %v despite the block", got)
	}
}

// Test 6: same-org peers with no block relationship must still be able to
// call each other — the new check must not become a new way to fail an
// otherwise-legitimate call.
func TestHandleCallFrame_SameOrgNoBlockStillDelivers(t *testing.T) {
	h := hub.New()
	presence := &fakePresenceChecker{online: map[string]bool{"org-1\x00u-target": true}}
	blocks := &fakeBlockChecker{blocked: map[string]bool{}} // nobody blocked
	sig := rtcsignal.New(h, presence, blocks, nil, discardLog())
	s := newTestServerWithSignal(nil, nil, sig)

	target := hub.NewConn("u-target", "c-target")
	h.Add(target, 0, 0)
	caller := hub.NewConn("u-sender", "c-sender")
	h.Add(caller, 0, 0)

	s.handleClientFrame(context.Background(), caller, testSession(), callInviteFrame("u-target", "call-1"))

	got := drainSendTypes(t, target)
	if len(got) != 1 || got[0] != "call.invite" {
		t.Fatalf("target frames = %v, want exactly one call.invite", got)
	}
}

// TestDeliverCtx_BacklogLargerThanBufferIsDeliveredWithoutClosing is the
// regression guard for the connect→replay→overflow→disconnect loop. The hello
// replay can exceed the send buffer (sendChanCap=256) for a backlogged client;
// it MUST be delivered in full without closing the connection, as long as a
// writeLoop-style consumer drains. The old non-blocking drop-and-close tripped
// conn.Close() the instant the buffer filled, so this test fails on that code.
func TestDeliverCtx_BacklogLargerThanBufferIsDeliveredWithoutClosing(t *testing.T) {
	conn := hub.NewConn("u-1", "c1")

	const total = 1000 // >> sendChanCap (256)
	got := make(chan int, 1)
	go func() { // drain like writeLoop, slowly enough that the producer races ahead
		n := 0
		for {
			select {
			case <-conn.Send:
				n++
				if n == total {
					got <- n
					return
				}
				time.Sleep(20 * time.Microsecond)
			case <-conn.Done:
				got <- n
				return
			}
		}
	}()

	ctx := context.Background()
	for i := 0; i < total; i++ {
		if !deliverCtx(ctx, conn, []byte(`{"type":"x"}`)) {
			t.Fatalf("deliverCtx returned false at frame %d (connection closed mid-replay)", i)
		}
	}

	select {
	case n := <-got:
		if n != total {
			t.Fatalf("consumer received %d frames, want %d (connection closed early)", n, total)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for replay to drain")
	}

	select {
	case <-conn.Done:
		t.Fatal("connection was closed during replay; backpressure must keep it open")
	default:
	}
}

// TestDeliverCtx_BailsWhenConsumerStuckAndCtxCancelled proves the stuck-client
// safety: with nothing draining a full buffer, deliverCtx blocks only until ctx
// is cancelled (in production writeLoop's writeTimeout cancels it), then returns
// false rather than blocking forever.
func TestDeliverCtx_BailsWhenConsumerStuckAndCtxCancelled(t *testing.T) {
	conn := hub.NewConn("u-1", "c1")
	for i := 0; i < cap(conn.Send); i++ { // fill to capacity so the next send blocks
		conn.Send <- []byte("x")
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()

	done := make(chan bool, 1)
	go func() { done <- deliverCtx(ctx, conn, []byte("blocked")) }()

	select {
	case ok := <-done:
		if ok {
			t.Fatal("deliverCtx returned true, but the buffer was full and ctx was cancelled")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("deliverCtx did not return after ctx cancellation (blocked forever)")
	}
}

// itoa is a tiny dependency-free int-to-string for stable, ordered ids.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
