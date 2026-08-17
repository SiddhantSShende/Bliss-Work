package push

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/task-board/ws-gateway/internal/metrics"
)

// Fanout delivers a payload to a set of users wherever their sockets are.
//
// ── What this replaces ───────────────────────────────────────────────────────
// Cross-node delivery for RTC signalling and presence used Redis pub/sub:
// `PSUBSCRIBE rtc:user:*` and a single `presence:events` channel. Both are
// BROADCASTS — every gateway node received every frame addressed to anyone,
// matched it against its own sockets, and discarded the rest. That is the same
// mistake the Kafka fan-out had, in a different transport, and it has the same
// shape: cost scales with node count rather than with traffic.
//
// It also does not survive sharding. Classic Redis pub/sub is delivered to
// EVERY node of a cluster regardless of which slot a channel name would hash
// to, so moving Redis to a cluster would not have divided this work at all.
//
// The routing table already exists — presence records `nodeId:connId` per user,
// and the node registry maps a nodeId to an address — so this is the same
// lookup routed event delivery makes, applied to the two paths that were still
// broadcasting.
//
// ── Local first ──────────────────────────────────────────────────────────────
// Sockets on THIS node are served in-process and never touch the network. The
// registry is still consulted afterwards, because a user may hold sockets in
// two places at once — a laptop here and a phone elsewhere — and delivering
// only locally would leave the other device silent. This node's own id is
// excluded from the push targets so those local sockets are not served twice.
type Fanout struct {
	store      NodeStore
	local      LocalDeliverer
	transport  Transport
	selfNodeID string
	log        *slog.Logger
}

// NodeStore is the slice of the Redis store this needs: WHO IS WHERE, and
// nothing else.
//
// It used to also carry NodeAddrs and ForgetNodeAddr — how to REACH a node, and
// how to forget a stale route. Both moved into Transport, because both are
// answers to "how do I contact node N", which is exactly the question a
// pluggable transport exists to own. A subject-based transport has no address to
// resolve and no address cache to invalidate; asking it for those through this
// interface would have been asking it to pretend to be HTTP.
type NodeStore interface {
	NodesForUsers(ctx context.Context, userIDs []string) (map[string][]string, error)
}

// LocalDeliverer enqueues to sockets on this node. Satisfied by *hub.Hub;
// reports whether the user had any socket here.
type LocalDeliverer interface {
	Fanout(userID string, payload []byte) bool
}

// maxParallelPushes bounds concurrent per-node requests for one delivery.
// Sequential would let one slow node delay every other node's copy; unbounded
// would open a connection per node per event on a large fleet.
const maxParallelPushes = 16

// NewFanout builds a Fanout. selfNodeID must be this process's node id — the
// same one it registers under and stamps into presence entries.
func NewFanout(
	store NodeStore, local LocalDeliverer, transport Transport, selfNodeID string, log *slog.Logger,
) *Fanout {
	return &Fanout{store: store, local: local, transport: transport, selfNodeID: selfNodeID, log: log}
}

// Deliver sends one payload to every live socket of every named user.
//
// Best-effort by design, like the pub/sub it replaces. Neither RTC signalling
// nor presence is persisted for replay: a dropped ICE candidate is retried by
// the peer, and a missed presence transition is corrected by the next snapshot
// on hello or the periodic poll. Failing the caller would turn a transient blip
// into a failed call setup or a stuck avatar, which is worse than the gap.
func (f *Fanout) Deliver(ctx context.Context, userIDs []string, payload []byte) {
	if len(userIDs) == 0 || len(payload) == 0 {
		return
	}

	// 1. Anyone here is served without touching the network.
	served := make(map[string]bool, len(userIDs))
	for _, uid := range userIDs {
		if f.local.Fanout(uid, payload) {
			served[uid] = true
		}
	}
	if len(served) > 0 {
		metrics.NodeFanoutRecipientsTotal.WithLabelValues(metrics.WhereLocal).
			Add(float64(len(served)))
	}

	// 2. Everyone else, via the nodes that actually hold them.
	nodes, err := f.store.NodesForUsers(ctx, userIDs)
	if err != nil {
		f.log.Warn("fanout routing lookup failed", "users", len(userIDs), "err", err)
		return
	}
	byNode := make(map[string][]string, len(nodes))
	for uid, nodeIDs := range nodes {
		for _, n := range nodeIDs {
			if n == f.selfNodeID {
				continue // already delivered in step 1
			}
			byNode[n] = append(byNode[n], uid)
			// A user with sockets on two peers is one reachable recipient, not
			// two, so this is a set rather than a count — otherwise a two-device
			// user would mask an unroutable one.
			served[uid] = true
		}
	}
	// Reachable nowhere: no socket here and no registered node holding them.
	// Usually a peer who disconnected between the presence read and now — but on
	// a fleet with WS_ADVERTISE_ADDR unset it is EVERY non-local recipient, and
	// this counter is the only thing that says so. See the metric's comment.
	if unroutable := len(userIDs) - len(served); unroutable > 0 {
		metrics.NodeFanoutUnroutableTotal.Add(float64(unroutable))
	}
	if len(byNode) == 0 {
		return
	}

	// No address lookup here any more: the transport owns reaching a node, so
	// this dispatches straight to it. That also removes the barrier this used to
	// have — every node's route is now resolved inside its own goroutine rather
	// than in one blocking pass before any of them start.
	sem := make(chan struct{}, maxParallelPushes)
	var wg sync.WaitGroup
	for nodeID, users := range byNode {
		wg.Add(1)
		sem <- struct{}{}
		go func(nodeID string, users []string) {
			defer wg.Done()
			defer func() { <-sem }()

			_, err := f.transport.Send(ctx, nodeID, Batch{
				Broadcast: &Broadcast{UserIDs: users, Payload: payload},
			})
			switch {
			case err == nil:
				metrics.NodeFanoutRecipientsTotal.WithLabelValues(metrics.WhereRemote).
					Add(float64(len(users)))
			case errors.Is(err, ErrNodeUnreachable):
				// Ordinary: the registration expired between the presence read
				// and here — the node died or is restarting, and its sockets went
				// with it. Counted as unroutable rather than failed, because a
				// fleet with WS_ADVERTISE_ADDR unset produces nothing BUT this and
				// the two must not be conflated in the same metric.
				metrics.NodeFanoutUnroutableTotal.Add(float64(len(users)))
			default:
				f.log.Warn("fanout push failed", "node", nodeID, "users", len(users), "err", err)
			}
			metrics.NodeFanoutRequestsTotal.WithLabelValues(metrics.Result(err)).Inc()
		}(nodeID, users)
	}
	wg.Wait()
}
