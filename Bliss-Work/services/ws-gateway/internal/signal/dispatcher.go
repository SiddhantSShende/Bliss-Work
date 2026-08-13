package signal

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

// Dispatcher routes signaling frames between connected users.
//
// Same-node delivery: hub.Fanout(toUserId, raw). Cross-node delivery:
// Redis PUBLISH on rtc:user:<toUserId>. Each gateway node has its own
// PSUBSCRIBE rtc:user:* that funnels incoming payloads into local Fanout.
//
// fromUserId is provided by the caller (gateway has the verified JWT
// claims), NOT trusted from the client wire frame.
type Dispatcher struct {
	hub   *hub.Hub
	store *store.Store
	log   *slog.Logger
}

// New constructs a Dispatcher.
func New(h *hub.Hub, st *store.Store, log *slog.Logger) *Dispatcher {
	return &Dispatcher{hub: h, store: st, log: log}
}

// RunSubscriber starts the Redis PSUBSCRIBE loop on rtc:user:*. Blocks until
// ctx is done. Started once per process (typically from cmd/ws-gateway/main.go).
func (d *Dispatcher) RunSubscriber(ctx context.Context) {
	d.store.SubscribeRTC(ctx, func(userID string, raw []byte) {
		// On cross-node delivery, only deliver if we actually have the user
		// here — protects against a thundering-herd pattern where every node
		// fans out a frame addressed to one specific user.
		if !d.hub.HasUser(userID) {
			return
		}
		d.hub.Fanout(userID, raw)
	})
}

// Forward routes a signaling frame from `from` to `to`. The caller is
// responsible for the rate limit check (per-conn) before calling.
//
// `senderOrg` is the orgId of the sender; the dispatcher rejects cross-org
// destinations by returning false. In that case the caller should write a
// rtc.peer.unreachable control frame back to the sender's own socket.
func (d *Dispatcher) Forward(
	ctx context.Context, senderOrg, fromUserID, toUserID string, f Frame,
) (delivered bool) {
	// Same-org enforcement: only forward to a peer that is online in the SENDER's
	// org. org presence lives in shared Redis, so this also covers the cross-node
	// case. A cross-org (or offline) destination is reported unreachable, leaking
	// nothing about who exists in other orgs. (Previously unchecked — the doc
	// promised this but the code did not enforce it.)
	if ok, err := d.store.IsOnlineInOrg(ctx, senderOrg, toUserID); err != nil {
		d.log.Warn("rtc org check failed", "from", fromUserID, "to", toUserID, "err", err)
		return false
	} else if !ok {
		return false
	}

	// Stamp the sender identity from JWT claims. Strip the toUserId so the
	// recipient never learns more than it needs (its own ID is implicit).
	f.FromUserID = fromUserID
	f.ToUserID = ""
	raw, err := MarshalFrame(f)
	if err != nil {
		d.log.Warn("rtc forward marshal failed", "err", err)
		return false
	}

	if d.hub.HasUser(toUserID) {
		d.hub.Fanout(toUserID, raw)
		return true
	}

	if err := d.store.PublishRTC(ctx, toUserID, raw); err != nil {
		d.log.Warn("rtc publish failed",
			"from", fromUserID, "to", toUserID, "type", f.Type, "err", err)
		return false
	}
	return true
}

// UnreachableFrame returns a control frame the caller can send back to the
// sender's own connection when toUserId is not connected anywhere.
func UnreachableFrame(offerID, reason string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"type":    "rtc.peer.unreachable",
		"offerId": offerID,
		"reason":  reason,
	})
}

// RateLimitedFrame is shipped when the per-conn cap is exceeded.
func RateLimitedFrame(retryAfterMs int) ([]byte, error) {
	return json.Marshal(map[string]any{
		"type":         "rtc.rate_limited",
		"retryAfterMs": retryAfterMs,
	})
}
