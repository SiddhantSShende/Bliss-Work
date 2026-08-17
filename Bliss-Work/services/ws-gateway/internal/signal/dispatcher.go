package signal

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/push"
	"github.com/task-board/ws-gateway/internal/store"
	"github.com/task-board/ws-gateway/internal/ttlcache"
)

// Dispatcher routes signaling frames between connected users.
//
// ── Delivery ─────────────────────────────────────────────────────────────────
// Same-node: hub.Fanout(toUserId, raw), in process. Cross-node: a direct push
// to the node holding that user, resolved through the node registry.
//
// It used to be `PUBLISH rtc:user:<id>` against a Redis channel that every
// gateway node subscribed to with `PSUBSCRIBE rtc:user:*`. That meant EVERY
// node received EVERY signalling frame in the platform and dropped the ones it
// could not deliver — a broadcast, with cost scaling by node count rather than
// by traffic, and with pattern subscriptions being the most expensive kind
// Redis offers. It would not have survived clustering either: classic pub/sub
// is delivered to every node of a Redis cluster whatever the channel name
// hashes to, so sharding would have divided none of this.
//
// A signalling frame is addressed to exactly ONE user, which makes it the
// easiest thing in the system to route properly.
//
// fromUserId is provided by the caller (gateway has the verified JWT
// claims), NOT trusted from the client wire frame.
type Dispatcher struct {
	hub    *hub.Hub
	store  PresenceChecker
	fanout *push.Fanout
	peers  *ttlcache.Cache[bool]
	log    *slog.Logger
}

// PresenceChecker is the one question the dispatcher asks of shared state.
//
// An interface rather than *store.Store because this single call is the entire
// cross-org boundary for signalling, and a boundary that cannot be tested
// against a controlled answer is a boundary nobody can verify. With a concrete
// store the only reachable case was "Redis is unreachable"; the cases that
// matter — a same-org peer is allowed, a cross-org one is refused, and the cache
// in front of them preserves both — all need this seam.
type PresenceChecker interface {
	IsOnlineInOrg(ctx context.Context, orgID, userID string) (bool, error)
}

// Compile-time proof that the real store still satisfies it.
var _ PresenceChecker = (*store.Store)(nil)

// ── The peer cache ───────────────────────────────────────────────────────────
//
// Forward runs the same-org online check on EVERY frame, and signalling is
// bursty in a way that makes that expensive: an offer, an answer, and then a
// trickle of twenty to forty ICE candidates per side, all within a few seconds,
// all addressed to the same peer. Typing hints have the same shape. At the
// per-connection cap of 200 frames/second one socket could issue 200 Redis
// round trips per second asking a question whose answer had not changed.
//
// ── Why a cache does not weaken the check ────────────────────────────────────
// The check reads a heartbeat-scored set with a 120-second staleness window, so
// its answer was ALREADY up to two minutes behind reality — a peer who closed
// their laptop reads as online until their heartbeat ages out. Holding that same
// answer for a couple of seconds more does not meaningfully widen a window that
// is sixty times larger, and it changes nothing a client can observe: a peer who
// vanishes mid-call is detected by ICE and DTLS timeouts, not by this.
//
// ── Positives only ───────────────────────────────────────────────────────────
// A denial is never cached. "Not reachable" is the answer that changes on a
// timescale that matters — the peer is one heartbeat away from being online, and
// a user who retries a failed call deserves a live answer rather than a
// remembered refusal. Caching only positives also means the cache can never
// manufacture a denial, so it cannot make the cross-org gate refuse someone it
// would otherwise have allowed, nor allow anyone it had not already allowed
// within the TTL.
const (
	peerCacheTTL = 3 * time.Second

	// Room for every socket on a full node to be signalling a distinct peer,
	// with headroom. Overflow costs a re-read, not a failure.
	peerCacheMax = 50_000
)

// New constructs a Dispatcher. `fanout` may be nil in tests that only exercise
// same-node delivery.
func New(h *hub.Hub, st PresenceChecker, f *push.Fanout, log *slog.Logger) *Dispatcher {
	return &Dispatcher{
		hub:    h,
		store:  st,
		fanout: f,
		peers:  ttlcache.New[bool](peerCacheTTL, peerCacheMax),
		log:    log,
	}
}

// peerAllowed reports whether toUserID is an online member of senderOrg, using
// a short-lived cache of positive answers. See the commentary above.
func (d *Dispatcher) peerAllowed(ctx context.Context, senderOrg, toUserID string) (bool, error) {
	// The org is part of the key, not just the value. Two users in different
	// orgs asking about the same destination are asking different questions,
	// and merging them would be precisely the cross-org leak the check exists
	// to prevent.
	key := senderOrg + "\x00" + toUserID
	if _, ok := d.peers.Get(key); ok {
		metrics.RouteCacheTotal.WithLabelValues(metrics.CachePeer, metrics.CacheHit).Inc()
		return true, nil
	}
	metrics.RouteCacheTotal.WithLabelValues(metrics.CachePeer, metrics.CacheMiss).Inc()

	ok, err := d.store.IsOnlineInOrg(ctx, senderOrg, toUserID)
	if err != nil {
		return false, err
	}
	if ok {
		d.peers.Put(key, true)
	}
	return ok, nil
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
	if ok, err := d.peerAllowed(ctx, senderOrg, toUserID); err != nil {
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

	// Local first, and usually that is the whole story: a 1:1 call between two
	// colleagues frequently lands both of them on the same gateway.
	if d.hub.Fanout(toUserID, raw) {
		return true
	}
	if d.fanout == nil {
		// Same-node only. Reached in tests, and in a single-gateway deployment
		// where there is nowhere else a socket could be.
		return false
	}
	// Elsewhere in the fleet. Deliver resolves the peer's node from the same
	// presence entry the org check above already consulted, and pushes only
	// there — no other gateway hears about this frame.
	d.fanout.Deliver(ctx, []string{toUserID}, raw)
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
