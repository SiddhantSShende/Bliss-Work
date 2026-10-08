package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

// stallingRedisProxy forwards TCP to the real test Redis and, once armed,
// holds back any client chunk containing ZADD for `delay` — i.e. it keeps a
// heartbeat (TouchPresence) "in flight" while the socket is closed. Every other
// command (the cleanup's ZREM / EVALSHA) passes straight through.
type stallingRedisProxy struct {
	ln      net.Listener
	armed   atomic.Bool
	delay   time.Duration
	stalled chan struct{} // receives once when a ZADD is first held back
}

func newStallingRedisProxy(t *testing.T, target string, delay time.Duration) *stallingRedisProxy {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatalf("parse redis url: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	p := &stallingRedisProxy{ln: ln, delay: delay, stalled: make(chan struct{}, 1)}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go p.serve(c, u.Host)
		}
	}()
	return p
}

func (p *stallingRedisProxy) serve(client net.Conn, upstreamAddr string) {
	up, err := net.Dial("tcp", upstreamAddr)
	if err != nil {
		_ = client.Close()
		return
	}
	go func() { _, _ = io.Copy(client, up); _ = client.Close() }()
	buf := make([]byte, 64*1024)
	for {
		n, err := client.Read(buf)
		if n > 0 {
			if p.armed.Load() && bytes.Contains(bytes.ToUpper(buf[:n]), []byte("ZADD")) {
				select {
				case p.stalled <- struct{}{}:
				default:
				}
				time.Sleep(p.delay)
			}
			if _, werr := up.Write(buf[:n]); werr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	_ = up.Close()
	_ = client.Close()
}

func (p *stallingRedisProxy) redisURL(t *testing.T, real string) string {
	u, _ := url.Parse(real)
	u.Host = p.ln.Addr().String()
	return u.String()
}

// B-WS-6: a heartbeat that is in flight when the socket closes must not
// re-add the closed connection's presence after cleanup removed it.
func TestHeartbeatInFlightDoesNotResurrectClosedSocketPresence(t *testing.T) {
	// Skip early (like the other tests here) if the real Redis is unreachable.
	probe := newTestStore(t)
	_ = probe

	old := heartbeatInterval
	heartbeatInterval = 150 * time.Millisecond
	t.Cleanup(func() { heartbeatInterval = old })

	proxy := newStallingRedisProxy(t, testRedisURL(), 700*time.Millisecond)
	st, err := store.New(proxy.redisURL(t, testRedisURL()))
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	ta := newTestAuth(t)
	t.Cleanup(ta.close)
	h := hub.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := New(Config{WebOrigin: "http://localhost:5173"}, ta.verifier, h, st,
		nil, nil, nil, nil, "test-node", log, context.Background())
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	tsrv := &testServer{srv: srv, hub: h, auth: ta, ts: ts}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	userID, orgID := uuid.NewString(), uuid.NewString()
	token := ta.mint(t, userID, orgID, uuid.NewString(), time.Minute)
	c := tsrv.dial(t, ctx, token)
	done := drainInBackground(c)
	waitForHubCount(t, h, 1, 2*time.Second)

	// Wait for connect-time presence to land, then start stalling ZADDs.
	deadline := time.Now().Add(2 * time.Second)
	for {
		on, _ := st.OnlineAmong(ctx, []string{userID})
		if len(on) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("presence never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	proxy.armed.Store(true)

	select {
	case <-proxy.stalled:
	case <-time.After(3 * time.Second):
		t.Fatal("no heartbeat reached the proxy")
	}

	// Heartbeat is now held in flight; close the socket.
	_ = c.Close(websocket.StatusNormalClosure, "")
	waitClosed(t, done, 5*time.Second)
	waitForHubCount(t, h, 0, 3*time.Second)

	// Let the stalled heartbeat land (old code) / cleanup finish (new code).
	time.Sleep(1500 * time.Millisecond)
	proxy.armed.Store(false)

	if on, _ := st.OnlineAmong(ctx, []string{userID}); len(on) != 0 {
		t.Fatalf("closed socket's connection presence was resurrected: %v", on)
	}
	if online, _ := st.IsOnlineInOrg(ctx, orgID, userID); online {
		t.Fatal("closed socket's org presence was resurrected")
	}
}
