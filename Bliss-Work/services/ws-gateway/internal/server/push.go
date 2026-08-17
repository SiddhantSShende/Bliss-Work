package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"net/http"

	wsmetrics "github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/push"
)

// handlePush receives fan-out deliveries addressed to sockets on THIS node.
//
// The receiving half of routed delivery. Where the Kafka consumer computes
// recipients for the whole platform and discards the ones it does not hold,
// this is handed only the users it does hold — so the work it does is the work
// that was needed.
//
// ── What this endpoint is trusted to do, and what it is not ──────────────────
// It fans a payload out to a named user's sockets, verbatim. It does NOT parse
// the payload, decide who should receive it, or check that the caller is
// entitled to reach that user — all of that was settled by the delivery service
// reading a recipient list the producers computed. The shared secret is the
// whole authorization, which is the same trust model the delivery-ack path
// already uses in the other direction.
//
// That makes TB_INTERNAL_TOKEN a credential of real weight: anyone holding it
// can deliver an arbitrary payload to any connected user. It must never be
// exposed off the internal network, and this route is deliberately not part of
// the CORS-allowed browser surface.
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Constant-time compare: this is a secret equality check on a request path,
	// and a length-independent early return would leak the token a byte at a
	// time to anyone who can measure it.
	got := r.Header.Get(push.TokenHeader)
	if s.cfg.InternalToken == "" ||
		subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.InternalToken)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var batch push.Batch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, push.MaxBodyBytes))
	if err := dec.Decode(&batch); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	var res push.Result
	// Fanout is non-blocking and sheds a socket whose buffer is full, so a slow
	// client cannot make this request hang — the same property that lets the
	// Kafka consumer share one goroutine across every recipient.
	deliver := func(userID string, payload []byte) {
		if s.hub.Fanout(userID, payload) {
			res.Accepted++
			wsmetrics.PushReceivedTotal.WithLabelValues("delivered").Inc()
			return
		}
		// The user disconnected between the sender reading the routing table
		// and this landing. Ordinary rather than an error: for fan-out the
		// event is in their replay outbox, and signalling and presence are
		// both best-effort by design.
		res.Missing++
		wsmetrics.PushReceivedTotal.WithLabelValues("missing").Inc()
	}

	for _, d := range batch.Deliveries {
		if d.UserID == "" || !hasPayload(d.Payload) {
			continue
		}
		deliver(d.UserID, d.Payload)
	}

	// One payload, many recipients — the presence shape. Handled alongside
	// Deliveries rather than instead of them: a batch carrying both is a caller
	// bug worth tolerating, not worth dropping deliveries over.
	if b := batch.Broadcast; b != nil && hasPayload(b.Payload) {
		for _, uid := range b.UserIDs {
			if uid == "" {
				continue
			}
			deliver(uid, b.Payload)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

// hasPayload reports whether a delivery carries an actual event.
//
// The JSON null check is not defensive padding. A Delivery built with no
// Payload marshals its nil json.RawMessage as the literal `null`, which decodes
// back into a FOUR-BYTE slice rather than an empty one — so a length check
// alone passes it, and the gateway forwards `null` to the socket as a frame no
// client can parse. Absent and null are the same thing here and both are
// skipped.
func hasPayload(p json.RawMessage) bool {
	trimmed := bytes.TrimSpace(p)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}
