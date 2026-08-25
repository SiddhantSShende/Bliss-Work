// Package signal owns the WebRTC signaling routing in ws-gateway.
//
// The four frames (rtc.offer / rtc.answer / rtc.ice / rtc.cancel) are
// CONTROL frames — they're NOT persisted to the Redis per-user replay outbox
// ZSET, NOT produced to Kafka, NOT subject to consume-all-and-filter. They
// fly directly from sender to recipient via:
//
//   - Local Hub.Fanout when both peers are on the same node.
//   - A direct push to the node holding the recipient when they're not,
//     resolved through the node registry (see push.Fanout in dispatcher.go).
//
// fromUserId is STAMPED by the gateway from the verified JWT claims; clients
// must not send it. Cross-org sends are rejected with rtc.peer.unreachable.
//
// Per-conn rate limit: 200 frames/s. Excess fires rtc.rate_limited control
// frame; the connection is NOT dropped (an over-zealous peer should slow
// down, not get killed).
package signal

import (
	"encoding/json"
	"sync"
	"time"
)

// MaxRatePerSec caps individual conn signaling throughput.
const MaxRatePerSec = 200

// RateWindow is the rolling-window length used by the leaky-bucket limiter.
const RateWindow = time.Second

// Frame is the on-the-wire signaling frame. Fields are intentionally a
// superset of the four discriminants — unused fields ride as zero-values.
type Frame struct {
	Type                 string `json:"type"`
	FromUserID           string `json:"fromUserId,omitempty"`
	ToUserID             string `json:"toUserId,omitempty"`
	OfferID              string `json:"offerId,omitempty"`
	SDP                  string `json:"sdp,omitempty"`
	Candidate            string `json:"candidate,omitempty"`
	Reason               string `json:"reason,omitempty"`
	ResumeFromChunkIndex *int64 `json:"resumeFromChunkIndex,omitempty"`
	// typing
	ConversationID string `json:"conversationId,omitempty"`
	State          string `json:"state,omitempty"`
	// call lifecycle
	CallID string `json:"callId,omitempty"`
	Media  string `json:"media,omitempty"`
	// FromName is the caller's display name, stamped by the gateway from the
	// verified JWT claims so the callee can show who is ringing. Never taken
	// from the client frame — a client-supplied name would be spoofable.
	FromName string `json:"fromName,omitempty"`
}


// MarshalFrame writes a Frame back as JSON.
func MarshalFrame(f Frame) ([]byte, error) { return json.Marshal(f) }

// Limiter implements a per-conn leaky bucket. Allow() returns false when the
// caller has burned through its 1-second budget.
type Limiter struct {
	mu     sync.Mutex
	stamps []time.Time
}

// Allow records this call's timestamp and returns whether the conn is under
// the per-second cap.
func (l *Limiter) Allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-RateWindow)
	// Drop stamps older than the window in a single sweep.
	keep := l.stamps[:0]
	for _, t := range l.stamps {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	l.stamps = keep
	if len(l.stamps) >= MaxRatePerSec {
		return false
	}
	l.stamps = append(l.stamps, now)
	return true
}
