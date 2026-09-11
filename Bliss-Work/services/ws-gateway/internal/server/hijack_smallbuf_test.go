package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// TestHandleWS_LargeMessageRoundTrip proves the shrunk (smallBufHijackSize)
// read AND write buffers still handle a message far larger than themselves,
// in both directions, with the complete payload preserved exactly:
//
//   - client -> server forces io.ReadFull (read.go) across multiple internal
//     bufio fills, since the frame is ~8x smallBufHijackSize.
//   - server -> client forces bufio.Writer.Flush (write.go) across multiple
//     internal writes, via the hub's real fan-out delivery path (the same
//     writeLoop -> ws.Write route a live event takes in production).
func TestHandleWS_LargeMessageRoundTrip(t *testing.T) {
	ts := newTestServer(t, context.Background())
	userID := uuid.NewString()
	token := ts.auth.mint(t, userID, uuid.NewString(), uuid.NewString(), time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := ts.dial(t, ctx, token)
	defer c.Close(websocket.StatusNormalClosure, "")

	send(t, ctx, c, map[string]any{"type": "hello"})
	readUntil(t, ctx, c, "ready")
	readUntil(t, ctx, c, "replay.done")

	clientPad := strings.Repeat("x", 8000) // far exceeds smallBufHijackSize (1024) both ways
	send(t, ctx, c, map[string]any{"type": "ping", "pad": clientPad})
	got := readUntil(t, ctx, c, "pong")
	if got["type"] != "pong" {
		t.Fatalf("expected pong, got %v", got)
	}

	serverPad := strings.Repeat("y", 8000)
	raw, err := json.Marshal(map[string]any{"type": "large", "pad": serverPad})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	waitForHubCount(t, ts.hub, 1, time.Second)
	if !ts.hub.Fanout(userID, raw) {
		t.Fatalf("Fanout: no local connection delivered to")
	}
	frame := readUntil(t, ctx, c, "large")
	gotPad, _ := frame["pad"].(string)
	if gotPad != serverPad {
		t.Fatalf("server->client large payload corrupted: got %d bytes, want %d", len(gotPad), len(serverPad))
	}
}

// TestHandleWS_PipelinedBacklogFallsBackToDefaultBuffers proves the safety
// fallback in smallBufHijacker.Hijack: when a client's first write already
// contains more than smallBufHijackSize bytes' worth of data beyond the HTTP
// upgrade request itself (a client that sends its first frame without
// waiting for the 101 response), the wrapper must NOT shrink the buffer.
// Doing so anyway would either drop those pre-buffered bytes outright or
// silently truncate/corrupt the first websocket frame — a correctness bug
// that would not fail loudly.
//
// This dials a raw TCP connection and writes the HTTP upgrade request and a
// masked ~2 KB websocket frame in a single write, before reading anything
// back — that is what makes the extra bytes land inside net/http's own
// header-parsing read and still be sitting in its bufio.Reader's buffer
// (Buffered() > 0) at the exact moment Hijack() runs, i.e. genuine
// pipelining, not merely a small buffer size.
func TestHandleWS_PipelinedBacklogFallsBackToDefaultBuffers(t *testing.T) {
	ts := newTestServer(t, context.Background())
	token := ts.auth.mint(t, uuid.NewString(), uuid.NewString(), uuid.NewString(), time.Minute)

	addr := ts.ts.Listener.Addr().String()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	// 2000 bytes of JSON payload — comfortably larger than smallBufHijackSize
	// (1024), so the backlog genuinely cannot fit the shrunk buffer.
	payload := []byte(`{"type":"ping","pad":"` + strings.Repeat("z", 2000) + `"}`)
	wireFrame := maskedTextFrame(t, payload)

	req := "GET /ws?token=" + token + " HTTP/1.1\r\n" +
		"Host: " + addr + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"\r\n"

	// Request + frame in ONE write, before any read: the request handler
	// (InsecureSkipVerify is set, so Origin is irrelevant here) sees both in
	// the same underlying read.
	if _, err := conn.Write(append([]byte(req), wireFrame...)); err != nil {
		t.Fatalf("write request+frame: %v", err)
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}

	// The pipelined "ping" must have been preserved intact (not dropped,
	// reordered, or corrupted) despite the fallback keeping the larger
	// default buffers, and answered normally with "pong".
	opcode, got := readRawFrame(t, br)
	if opcode != 1 {
		t.Fatalf("opcode = %d, want 1 (text)", opcode)
	}
	var f map[string]any
	if err := json.Unmarshal(got, &f); err != nil {
		t.Fatalf("unmarshal reply: %v (%q)", err, got)
	}
	if f["type"] != "pong" {
		t.Fatalf("got %v, want pong", f)
	}
}

// maskedTextFrame builds a single unfragmented, masked, FIN text frame, as
// RFC 6455 requires for every client->server frame.
func maskedTextFrame(t *testing.T, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteByte(0x81) // FIN=1, opcode=1 (text)

	n := len(payload)
	switch {
	case n <= 125:
		buf.WriteByte(0x80 | byte(n))
	case n <= 65535:
		buf.WriteByte(0x80 | 126)
		buf.WriteByte(byte(n >> 8))
		buf.WriteByte(byte(n))
	default:
		t.Fatalf("test helper does not support frames > 65535 bytes")
	}

	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		t.Fatalf("generate mask key: %v", err)
	}
	buf.Write(mask[:])

	masked := make([]byte, n)
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	buf.Write(masked)
	return buf.Bytes()
}

// readRawFrame reads one server->client websocket frame (unmasked, per RFC
// 6455) from br and returns its opcode and payload.
func readRawFrame(t *testing.T, br *bufio.Reader) (opcode byte, payload []byte) {
	t.Helper()
	head := make([]byte, 2)
	if _, err := io.ReadFull(br, head); err != nil {
		t.Fatalf("read frame header: %v", err)
	}
	opcode = head[0] & 0x0f
	masked := head[1]&0x80 != 0
	length := int(head[1] & 0x7f)

	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(br, ext); err != nil {
			t.Fatalf("read extended length: %v", err)
		}
		length = int(ext[0])<<8 | int(ext[1])
	case 127:
		ext := make([]byte, 8)
		if _, err := io.ReadFull(br, ext); err != nil {
			t.Fatalf("read extended length: %v", err)
		}
		length = 0
		for _, b := range ext {
			length = length<<8 | int(b)
		}
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(br, maskKey[:]); err != nil {
			t.Fatalf("read mask key: %v", err)
		}
	}

	payload = make([]byte, length)
	if _, err := io.ReadFull(br, payload); err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return opcode, payload
}
