package server

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
)

// smallBufHijackSize is the read/write buffer size installed in place of
// net/http's 4096/4096-byte hijack buffers for every websocket connection.
// See smallBufHijacker for why this is safe.
//
// Validated experimentally against a running gateway (Candidate B
// investigation): real VmRSS/connection dropped by ~5-6.5 KB at this size,
// with goroutines/connection and StackInuse/connection unchanged — confirming
// the saving is attributable to the buffers themselves, not some incidental
// side effect. Not made configurable: the investigation found no
// architectural need to vary this in production, and an unused knob is more
// risk than a fixed, validated constant.
const smallBufHijackSize = 1024

// smallBufHijacker wraps an http.ResponseWriter so that, at Hijack() time
// (called from inside websocket.Accept), the net/http-allocated 4096-byte
// bufio.Reader/Writer are replaced with smallBufHijackSize-byte ones before
// coder/websocket adopts them for the connection's entire lifetime.
//
// websocket.Accept never allocates its own reader/writer — it uses whatever
// *bufio.Reader/*bufio.Writer the Hijacker it's given returns, for as long as
// the connection lives (coder/websocket@v1.8.13's accept.go passes
// brw.Reader/brw.Writer straight into the Conn it builds). Substituting
// smaller ones here, once, is therefore enough to shrink that per-connection
// footprint for the connection's whole life — no fork, no coder/websocket
// change, no unsafe/reflection.
type smallBufHijacker struct {
	http.ResponseWriter
	size int
}

func newSmallBufHijacker(w http.ResponseWriter, size int) *smallBufHijacker {
	return &smallBufHijacker{ResponseWriter: w, size: size}
}

// Unwrap lets http.ResponseController (and anything else walking this chain)
// still reach whatever the wrapped writer itself exposes, the same way
// statusRecorder.Unwrap does one layer further down. Not required for the
// Accept() path below (which finds Hijack directly on this type), but keeps
// this wrapper from becoming an opaque wall for any other interface a caller
// might reasonably look for.
func (s *smallBufHijacker) Unwrap() http.ResponseWriter {
	return s.ResponseWriter
}

// Hijack is what coder/websocket's Accept() actually calls — its own
// internal Unwrap-chain-walking helper finds this method directly, since
// smallBufHijacker itself satisfies http.Hijacker.
func (s *smallBufHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	// s.ResponseWriter is not necessarily a direct http.Hijacker — this
	// server's own metrics.statusRecorder, for one, exposes Hijack only via
	// Unwrap(). http.NewResponseController walks that chain the same way
	// coder/websocket's own accept() does, so this works regardless of what
	// middleware sits between here and the real *http.response.
	netConn, brw, err := http.NewResponseController(s.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}

	// The write side is always safe to shrink: net/http's (*response).Hijack
	// flushes the chunk writer through to the raw connection before
	// hijackLocked() resets bufw, so Buffered() on the write side is
	// guaranteed 0 here, every time — nothing can be lost by discarding it.
	//
	// The read side may hold bytes the client already sent immediately
	// behind the HTTP upgrade request (pipelining). Those must be preserved
	// exactly, in order, with nothing dropped, reordered, or duplicated.
	buffered := brw.Reader.Buffered()
	if buffered > s.size {
		// The pending backlog wouldn't fit in the smaller buffer.
		// Correctness over saving: keep the original 4096/4096 buffers for
		// this connection rather than risk losing bytes.
		return netConn, brw, nil
	}

	peeked, _ := brw.Reader.Peek(buffered)
	preserved := append([]byte(nil), peeked...) // Peek's slice is invalidated by the Reset below

	newBr := bufio.NewReaderSize(io.MultiReader(bytes.NewReader(preserved), netConn), s.size)
	if len(preserved) > 0 {
		// Force the preserved bytes into the new reader's own internal
		// buffer now. websocket.Accept's own defensive
		// Peek(Buffered())+Reset(MultiReader(...)) — its workaround for
		// golang/go#32314 — only carries forward what Buffered() reports at
		// that moment; without this Peek here, Buffered() would read 0 and
		// Accept would silently drop the preserved bytes instead of carrying
		// them forward.
		_, _ = newBr.Peek(len(preserved))
	}
	newBw := bufio.NewWriterSize(netConn, s.size)

	return netConn, bufio.NewReadWriter(newBr, newBw), nil
}
