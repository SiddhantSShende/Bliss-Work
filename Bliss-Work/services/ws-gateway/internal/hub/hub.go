package hub

import (
	"sync"
)

// sendChanCap is the per-connection outbound buffer size. Sized to absorb a
// burst of live events while the writer goroutine drains over the network. The
// connect-time replay does NOT use this overflow path (it uses deliverCtx
// backpressure and is independently bounded), so this only governs live fan-out;
// a genuinely slow consumer that fills it is shed (see Fanout).
const sendChanCap = 512

// Conn represents a single locally-connected websocket from a user.
type Conn struct {
	UserID string
	ConnID string
	Send   chan []byte
	// closeOnce guards Done so it is only closed a single time.
	closeOnce sync.Once
	Done      chan struct{}
}

// NewConn creates a connection handle with a buffered send channel.
func NewConn(userID, connID string) *Conn {
	return &Conn{
		UserID: userID,
		ConnID: connID,
		Send:   make(chan []byte, sendChanCap),
		Done:   make(chan struct{}),
	}
}

// Close signals the connection's goroutines to stop. Idempotent.
func (c *Conn) Close() {
	c.closeOnce.Do(func() { close(c.Done) })
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
func (h *Hub) Add(c *Conn, maxTotal, maxPerUser int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if maxTotal > 0 && h.total >= maxTotal {
		return false
	}
	conns := h.users[c.UserID]
	if maxPerUser > 0 && len(conns) >= maxPerUser {
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

// HasUser reports whether at least one connection for userID is currently
// registered on this node. Phase 9's signal dispatcher uses this to decide
// between local Fanout and cross-node Redis pub/sub delivery.
func (h *Hub) HasUser(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.users[userID]) > 0
}

// Fanout enqueues payload to every locally-connected socket of userID. It is
// called from the SHARED Kafka fan-out goroutine, so it MUST stay non-blocking:
// blocking on one slow client here would head-of-line-block live delivery for
// every other user. A client whose buffer is full is therefore shed immediately
// (the writer reacts to Done and closes with 1011). No event is lost: every event
// is written to the per-user replay outbox BEFORE Fanout (see fanout.handle), so
// the shed client redelivers it on reconnect via the backpressure-bounded,
// loop-free hello replay and dedups on eventId — at-least-once that lands once.
func (h *Hub) Fanout(userID string, payload []byte) {
	h.mu.RLock()
	conns := h.users[userID]
	targets := make([]*Conn, 0, len(conns))
	for _, c := range conns {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		select {
		case c.Send <- payload:
		default:
			// Buffer full → genuinely slow consumer. Shed it; reconnect + outbox
			// replay recovers the gap.
			c.Close()
		}
	}
}
