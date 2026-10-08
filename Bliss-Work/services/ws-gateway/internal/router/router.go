// Package router turns one fan-out event into the set of pushes that deliver
// it, and nothing more.
//
// This is the piece that replaces broadcast. The old shape had every gateway
// pod do all of this for every event and then throw most of it away; here it
// happens once, in a service that holds no sockets, and each gateway is sent
// only the users it actually has.
//
// The order of operations is load-bearing:
//
//  1. write the replay outbox   — durability first, so a push that never
//     lands is recovered on reconnect
//  2. read the routing table    — who is online, and where
//  3. push to each node once    — batched per node, not per recipient
//
// Reversing 1 and 3 would open a window where a delivery is on the wire but not
// yet recoverable, which is precisely the case a crash would expose.
package router

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/task-board/ws-gateway/internal/contract"
	"github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/push"
	"github.com/task-board/ws-gateway/internal/safego"
)

// maxParallelPushes bounds how many nodes are pushed to concurrently for a
// single event. Sequential would make one slow node delay every other node's
// delivery; unbounded would let a large fleet open a connection per node per
// event. In practice the fleet is smaller than this and everything runs at once.
const maxParallelPushes = 16

// Store is the slice of the Redis store the router needs.
//
// An interface rather than the concrete *store.Store so the routing logic can
// be tested against a fake — the alternative is a live Redis for what is
// fundamentally a grouping problem.
// ForgetNodeAddr is here because NodeAddrs is served from an in-process cache.
// A push that fails is the strongest evidence available that a cached address no
// longer points at a live pod, so it is invalidated rather than served until its
// TTL runs out — this is the highest-volume push path in the system, so retrying
// a dead address for the rest of the TTL is the expensive version of the
// mistake.
type Store interface {
	AppendOutboxMulti(ctx context.Context, userIDs []string, scoreMs int64, raw []byte) error
	NodesForUsers(ctx context.Context, userIDs []string) (map[string][]string, error)
	NodeAddrs(ctx context.Context, nodeIDs []string) (map[string]string, error)
	ForgetNodeAddr(nodeID string)
}

// Pusher sends a batch to one node. Satisfied by *push.Client.
type Pusher interface {
	Push(ctx context.Context, addr string, deliveries []push.Delivery) (push.Result, error)
}

// Router routes events to the nodes holding their recipients.
type Router struct {
	store Store
	push  Pusher
	log   *slog.Logger
}

// New builds a Router.
func New(st Store, p Pusher, log *slog.Logger) *Router {
	return &Router{store: st, push: p, log: log}
}

// Route delivers one raw event.
//
// The return value is the consumer's commit decision, so it has to be exact:
//
//   - nil means the event is DONE: delivered, or deliberately skipped because no
//     retry could ever make it deliverable (unparseable, or addressed to no one).
//     The offset may move.
//   - an error means a dependency failed transiently (Redis for the outbox write,
//     the routing table or node addresses) and the event is NOT done. The
//     caller must retry it and must not commit past it.
//
// This used to log those failures and return nothing, so the consumer committed
// the offset for an event whose outbox write or routing lookup had just failed:
// on a Redis blip every recipient lost the event outright — absent from replay
// AND never pushed live. Retrying is cheap and safe: the outbox write is an
// idempotent ZADD of the same member and clients dedupe on eventId.
//
// A failed push to a gateway is deliberately NOT an error here. By then every
// recipient's copy is durably in their replay outbox, so a dead pod costs that
// pod's users a reconnect, not a message — and retrying would stall the whole
// partition behind one pod that is mid-restart.
func (r *Router) Route(ctx context.Context, raw []byte) error {
	var ev contract.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		// Permanent: the same bytes will never parse. Skipped (and counted), not
		// retried — retrying would wedge the partition on one poison message.
		metrics.FanoutEventsSkippedTotal.WithLabelValues(metrics.SkipUnparseable).Inc()
		r.log.Warn("skip unparseable event", "err", err)
		return nil
	}
	recipients := ev.RecipientsOf()
	if len(recipients) == 0 {
		return nil // internal-only or unknown type; never pushed to a socket
	}
	metrics.FanoutRecipientsTotal.Add(float64(len(recipients)))

	// Recipients are resolved; the routing metadata has done its job. Strip it
	// before anything below stores or transmits a per-recipient copy.
	//
	// Routing the event properly (this file) removes the per-POD duplication but
	// NOT the per-recipient one: a channel roster shipped inside the event is
	// still written into every member's outbox, which is O(N²) in roster size.
	// Both fan-out modes need this, which is why it lives in contract.
	payload := contract.DeliveryPayload(raw)
	// The outbox may store a smaller reference instead (message.created only —
	// see contract.TryCompact); pushAll below always sends the full `payload`
	// to sockets, never the outbox copy — a socket has no reconstruction step.
	outboxPayload := contract.TryCompact(&ev, payload)

	// 1. Durability. One pipelined write for the whole recipient list.
	err := r.store.AppendOutboxMulti(ctx, recipients, contract.EpochMs(ev.OccurredAt), outboxPayload)
	result := metrics.Result(err)
	for range recipients {
		metrics.FanoutOutboxWritesTotal.WithLabelValues(result).Inc()
	}
	if err != nil {
		// Not "keep going": pushing now would deliver to live sockets but leave
		// the event out of replay, and the offset would then be committed past
		// it for everyone who was not connected at this moment.
		return fmt.Errorf("append outbox for %d recipients: %w", len(recipients), err)
	}

	// 2. Where is everyone?
	nodesByUser, err := r.store.NodesForUsers(ctx, recipients)
	if err != nil {
		return fmt.Errorf("routing lookup for %d recipients: %w", len(recipients), err)
	}

	// Recipients with no live node anywhere. Counted separately from delivery
	// failures because it is the ordinary state of an offline user, not a
	// fault — their events wait in the outbox until they reconnect.
	if unroutable := len(recipients) - countRouted(nodesByUser, recipients); unroutable > 0 {
		metrics.PushUnroutableTotal.Add(float64(unroutable))
	}

	// 3. Group, resolve, push.
	byNode := groupByNode(recipients, nodesByUser, payload)
	if len(byNode) == 0 {
		return nil // the whole audience is offline; nothing to send
	}

	nodeIDs := make([]string, 0, len(byNode))
	for id := range byNode {
		nodeIDs = append(nodeIDs, id)
	}
	addrs, err := r.store.NodeAddrs(ctx, nodeIDs)
	if err != nil {
		return fmt.Errorf("node address lookup for %d nodes: %w", len(nodeIDs), err)
	}
	r.pushAll(ctx, byNode, addrs)
	return nil
}

// pushAll fans the per-node batches out concurrently, bounded.
func (r *Router) pushAll(ctx context.Context, byNode map[string][]push.Delivery, addrs map[string]string) {
	sem := make(chan struct{}, maxParallelPushes)
	var wg sync.WaitGroup
	for nodeID, deliveries := range byNode {
		addr, ok := addrs[nodeID]
		if !ok {
			// The node's registration expired between the presence read and
			// here — it died, or is mid-restart. Its users' events are in the
			// outbox and replay on reconnect.
			metrics.PushSentTotal.WithLabelValues("error").Add(float64(len(deliveries)))
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(nodeID, addr string, ds []push.Delivery) {
			defer wg.Done()
			defer func() { <-sem }()

			// Guarded rather than let a panic here take down the process: this
			// goroutine already owns wg.Done()/sem release above (still needed
			// after a recovered panic), so only the push itself is wrapped.
			safego.Guard(r.log, "router.pushAll.node", func() {
				_, err := r.push.Push(ctx, addr, ds)
				res := metrics.Result(err)
				metrics.PushRequestsTotal.WithLabelValues(res).Inc()
				metrics.PushSentTotal.WithLabelValues(res).Add(float64(len(ds)))
				if err != nil {
					r.log.Warn("push failed", "addr", addr, "deliveries", len(ds), "err", err)
					// The address is cached; a failure says it may be stale. See Store.
					r.store.ForgetNodeAddr(nodeID)
				}
			})
		}(nodeID, addr, deliveries)
	}
	wg.Wait()
}

// groupByNode turns a recipient list plus a routing table into one batch per
// node, which is the shape that makes this a routed fan-out rather than a
// per-recipient one: a node holding forty of the recipients gets ONE request.
//
// A user connected on two nodes (a laptop and a phone) appears in both batches;
// each node fans out only to the sockets it holds.
func groupByNode(
	recipients []string, nodesByUser map[string][]string, raw []byte,
) map[string][]push.Delivery {
	byNode := make(map[string][]push.Delivery)
	for _, uid := range recipients {
		for _, nodeID := range nodesByUser[uid] {
			byNode[nodeID] = append(byNode[nodeID], push.Delivery{
				UserID: uid,
				// Every delivery shares the same backing array. json.Marshal
				// only reads it, and it is never mutated after this point, so
				// copying per recipient would allocate the event once per
				// member of a large channel for no benefit.
				Payload: raw,
			})
		}
	}
	return byNode
}

// countRouted returns how many recipients had at least one live node.
func countRouted(nodesByUser map[string][]string, recipients []string) int {
	n := 0
	for _, uid := range recipients {
		if len(nodesByUser[uid]) > 0 {
			n++
		}
	}
	return n
}
