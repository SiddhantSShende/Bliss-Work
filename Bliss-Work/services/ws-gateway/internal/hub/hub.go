package hub

import (
	"sync"

	"github.com/task-board/ws-gateway/internal/metrics"
)

// sendChanCap is the per-connection outbound buffer size. Sized to absorb a
// burst of live events while the writer goroutine drains over the network. The
// connect-time replay does NOT use this overflow path (it uses deliverCtx
// backpressure and is independently bounded), so this only governs live fan-out;
// a genuinely slow consumer that fills it is shed (see Fanout).
// ── Why this is 64 and not 512 ───────────────────────────────────────────────
// A buffered channel allocates its ring EAGERLY: `make(chan []byte, n)` costs
// n × 24 bytes (a slice header) the moment a socket connects, whether or not
// anything is ever queued. At 512 that was 12 KB per connection before a single
// event arrived, and with ~8 KB of goroutine stacks and ~8 KB of websocket
// buffers on top, a node ran out of memory somewhere near 13k sockets — while
// WS_MAX_CONNECTIONS said 50,000. The cap exists precisely so that a connection
// storm is REJECTED rather than OOM-killing the pod, and at those numbers the
// OOM won the race, so the protection never fired.
//
// 64 is chosen from what the buffer is FOR. It absorbs a burst while the writer
// drains; it is not a queue for a client that cannot keep up. A socket sitting
// on 64 undelivered events is not experiencing a burst, it is behind — and the
// shed-and-replay path in Fanout already handles that correctly and losslessly.
// Raising this trades memory for a longer grace period before shedding, which
// is the wrong direction: the replay is cheap and the memory is not.
const sendChanCap = 64

// Conn represents a single locally-connected websocket from a user.
type Conn struct {
	UserID string
	ConnID string
	// SessionID is the refresh-token family (auth.Claims.SessionID) that
	// authenticated this connection AT HANDSHAKE TIME. Deliberately fixed for
	// the life of the connection, even across an auth.renew that swaps
	// sess.claims to a token from the same identity: the socket was opened by
	// this session, so this is the session CloseSession must be able to find
	// it under. May be empty for a token minted before the `sid` claim
	// existed — such a connection is simply unreachable by a session-scoped
	// revoke (see internal/revoke) and relies on its own token's expiry.
	SessionID string
	Send      chan []byte
	// closeOnce guards Done so it is only closed a single time.
	closeOnce sync.Once
	Done      chan struct{}
	// closeReason is set (at most once, by CloseWithReason) BEFORE Done is
	// closed, and read by writeLoop only AFTER it receives from Done — the
	// channel close itself is what makes that safe without a mutex (Go's
	// memory model guarantees everything before close(ch) happens-before a
	// receive on ch observing the close). Empty for the plain Close() path,
	// which writeLoop maps to its pre-existing generic reason.
	closeReason string
}

// NewConn creates a connection handle with a buffered send channel.
func NewConn(userID, connID, sessionID string) *Conn {
	return &Conn{
		UserID:    userID,
		ConnID:    connID,
		SessionID: sessionID,
		Send:      make(chan []byte, sendChanCap),
		Done:      make(chan struct{}),
	}
}

// Close signals the connection's goroutines to stop. Idempotent.
func (c *Conn) Close() {
	c.closeOnce.Do(func() { close(c.Done) })
}

// CloseWithReason is Close, plus a reason writeLoop's Done handler uses to
// pick an accurate WebSocket close code/message instead of the generic
// "send buffer full" every plain Close() gets today. Idempotent like Close —
// on an already-closing connection the reason is silently dropped, same as a
// second plain Close() is a no-op.
func (c *Conn) CloseWithReason(reason string) {
	c.closeOnce.Do(func() {
		c.closeReason = reason
		close(c.Done)
	})
}

// CloseReason returns the reason passed to CloseWithReason, or "" for a plain
// Close(). Only safe to call after receiving from Done — see closeReason's
// doc comment for why no lock is needed given that ordering.
func (c *Conn) CloseReason() string {
	return c.closeReason
}

// Hub tracks locally-connected sockets keyed by userId.
type Hub struct {
	mu    sync.RWMutex
	users map[string]map[string]*Conn // userId -> connId -> Conn
	total int                         // node-wide connection count (cardinality cap)
}

// New creates an empty Hub.
func New() *Hub {
	return &Hub{users: make(map[string]map[string]*Conn)}
}

// Add registers a connection unless it would exceed maxTotal (node-wide) or
// maxPerUser (per user). A non-positive cap means unlimited. Returns false
// WITHOUT registering when a cap would be exceeded, so the caller can reject the
// upgrade — a single misbehaving client or a connection storm can't grow the
// goroutine/socket count without bound and OOM the pod.
// The rejection counter is incremented HERE rather than by the caller, because
// this is the only place that knows which of the two caps was hit — and those
// two mean opposite things. "node" is a fleet-capacity problem; "per_user" is
// one client reconnecting in a loop while the fleet is fine.
func (h *Hub) Add(c *Conn, maxTotal, maxPerUser int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if maxTotal > 0 && h.total >= maxTotal {
		metrics.ConnectionsRejectedTotal.WithLabelValues("node").Inc()
		return false
	}
	conns := h.users[c.UserID]
	if maxPerUser > 0 && len(conns) >= maxPerUser {
		metrics.ConnectionsRejectedTotal.WithLabelValues("per_user").Inc()
		return false
	}
	if conns == nil {
		conns = make(map[string]*Conn)
		h.users[c.UserID] = conns
	}
	conns[c.ConnID] = c
	h.total++
	return true
}

// Remove deregisters a connection.
func (h *Hub) Remove(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	conns := h.users[c.UserID]
	if conns == nil {
		return
	}
	if _, ok := conns[c.ConnID]; ok {
		delete(conns, c.ConnID)
		h.total--
	}
	if len(conns) == 0 {
		delete(h.users, c.UserID)
	}
}

// Count returns the number of connections currently registered on this node.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.total
}

// CloseAll signals every registered connection to tear down. Used on graceful
// shutdown so sockets close cleanly (and clients reconnect elsewhere) instead of
// being dropped abruptly when the process exits. Idempotent per connection.
func (h *Hub) CloseAll() {
	h.mu.RLock()
	targets := make([]*Conn, 0, h.total)
	for _, conns := range h.users {
		for _, c := range conns {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range targets {
		c.Close()
	}
}

// CloseSession force-closes every LOCAL connection registered under userID
// whose SessionID matches sessionID. Used when a refresh-token family is
// revoked (auth-svc's routes/sessions.py and routes/members.py, via the
// session.revoked Kafka event — see internal/revoke) so a live WebSocket
// doesn't keep working for the rest of its access token's TTL after the
// session that opened it has been revoked.
//
// Returns how many connections were closed. Zero is the ordinary outcome —
// the revoked session's own socket, if it has one at all, most often lives on
// a DIFFERENT node, which independently consumes the same event and finds it
// there instead; this method only ever touches THIS node's local registry.
//
// An empty sessionID matches nothing (rather than every connection of the
// user with no SessionID set) — see internal/revoke's handler for why a
// missing claim on the EVENT is refused before this is ever called; this
// check is the second, cheaper layer of the same discipline.
func (h *Hub) CloseSession(userID, sessionID string) int {
	if sessionID == "" {
		return 0
	}
	h.mu.RLock()
	conns := h.users[userID]
	targets := make([]*Conn, 0, len(conns))
	for _, c := range conns {
		if c.SessionID == sessionID {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.CloseWithReason("session revoked")
	}
	return len(targets)
}

// Fanout enqueues payload to every locally-connected socket of userID. It is
// called from the SHARED Kafka fan-out goroutine, so it MUST stay non-blocking:
// blocking on one slow client here would head-of-line-block live delivery for
// every other user. A client whose buffer is full is therefore shed immediately
// (the writer reacts to Done and closes with 1011). No event is lost: every event
// is written to the per-user replay outbox BEFORE Fanout (see fanout.handle), so
// the shed client redelivers it on reconnect via the backpressure-bounded,
// loop-free hello replay and dedups on eventId — at-least-once that lands once.
// Returns whether the user had ANY socket on this node — which is the
// difference between fan-out work that reached somebody and fan-out work this
// node did on behalf of a user it does not serve. Reporting it from here also
// spares the caller a second lock acquisition to ask HasUser the same question.
func (h *Hub) Fanout(userID string, payload []byte) (deliveredLocally bool) {
	h.mu.RLock()
	conns := h.users[userID]
	targets := make([]*Conn, 0, len(conns))
	for _, c := range conns {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		// Sampled before the send, so it is the depth this message FOUND rather
		// than the depth it caused. That is the number that says whether the
		// buffer is absorbing bursts or running permanently behind.
		metrics.SendBufferDepth.Observe(float64(len(c.Send)))
		select {
		case c.Send <- payload:
		default:
			// Buffer full → genuinely slow consumer. Shed it; reconnect + outbox
			// replay recovers the gap.
			metrics.ConnectionsShedTotal.Inc()
			c.Close()
		}
	}
	return len(targets) > 0
}
