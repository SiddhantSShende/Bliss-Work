package push

import (
	"context"
	"errors"
	"fmt"
)

// Transport delivers a Batch to a gateway node, identified by its NODE ID.
//
// ── Why the interface is keyed on a node id and not an address ───────────────
// Cross-node delivery used to be spelled `client.Push(ctx, addr, deliveries)`,
// with every caller doing its own `nodeID -> addr` lookup first. That signature
// looks pluggable and is not: `addr` is a base URL, so the ADDRESS PARAMETER IS
// THE HTTP ASSUMPTION. A transport that routes by subject, queue or stream has
// no address to be handed, and could not implement the interface without being
// lied to about what it is.
//
// Keying on the node id moves the question "how do I reach node N" inside the
// implementation, where it belongs. The HTTP transport resolves an address from
// the registry and POSTs to it. A NATS transport would publish to a subject
// derived from the same id and resolve nothing. Neither is visible to callers,
// which is the property that makes this actually swappable.
//
// It also removed a duplication rather than adding an indirection: Fanout and
// Router each carried their own copy of resolve-then-push, including their own
// handling of "the registration expired between the presence read and now".
// That logic now exists once.
//
// ── What an implementation owes callers ──────────────────────────────────────
//   - Send is best-effort. Every delivery is already durable in the recipient's
//     replay outbox (routed fan-out) or is inherently ephemeral (presence, RTC
//     signalling), so an implementation must never block indefinitely; it
//     should bound itself and return.
//   - It must be safe for concurrent use. Callers fan out to many nodes at once.
//   - It must return ErrNodeUnreachable, wrapped or bare, when it has no route
//     to the node at all — see that error for why the distinction matters.
type Transport interface {
	Send(ctx context.Context, nodeID string, batch Batch) (Result, error)
}

// ErrNodeUnreachable means the transport has no route to that node: its
// registration expired, or it never advertised one.
//
// Distinguished from a delivery failure because the two mean different things
// operationally and should not share a metric. A push that FAILED says the node
// is there and something went wrong reaching it — a network blip, a pod
// mid-restart. A node that is UNREACHABLE says the routing table no longer has
// an entry, which on a fleet with WS_ADVERTISE_ADDR unset is the steady state
// for every peer and is the single symptom that misconfiguration produces.
//
// Callers classify with errors.Is rather than by string, so an implementation
// may wrap it with detail.
var ErrNodeUnreachable = errors.New("push: node unreachable")

// AddrResolver is the slice of the node registry the HTTP transport needs.
//
// ForgetNodeAddr exists because NodeAddrs is served from an in-process cache. A
// failed push is the strongest evidence available that a cached address no
// longer points at a live pod, so the entry is invalidated rather than served
// until its TTL runs out. The next delivery re-reads and either learns the node
// is gone or confirms the failure was transient.
//
// Note this interface is declared HERE and not in fanout.go or router.go: with
// the transport owning address resolution, address lookup is no longer any
// caller's concern. Neither Fanout nor Router mentions an address at all now.
type AddrResolver interface {
	NodeAddrs(ctx context.Context, nodeIDs []string) (map[string]string, error)
	ForgetNodeAddr(nodeID string)
}

// HTTPTransport is the default Transport: resolve the node's advertised base
// URL from the registry, then POST the batch to it.
//
// This is the transport the platform has always used; it is now merely named,
// so that it is one implementation of something rather than the only way
// delivery can work.
type HTTPTransport struct {
	client *Client
	addrs  AddrResolver
}

// NewHTTPTransport wires the raw HTTP client to the node registry.
func NewHTTPTransport(client *Client, addrs AddrResolver) *HTTPTransport {
	return &HTTPTransport{client: client, addrs: addrs}
}

// Send resolves the node's address and posts the batch.
//
// Resolution is per-node rather than batched across a fan-out, and that costs
// nothing in practice: NodeAddrs is backed by an in-process TTL cache, so a warm
// lookup is a map read, and callers already fan out to nodes CONCURRENTLY — so
// on a cold cache N goroutines issue N GETs in parallel rather than one pipeline
// serially. Same round-trip wall time, and the resolve now sits inside the
// goroutine that needs it instead of in a barrier before them all.
func (t *HTTPTransport) Send(ctx context.Context, nodeID string, batch Batch) (Result, error) {
	addrs, err := t.addrs.NodeAddrs(ctx, []string{nodeID})
	if err != nil {
		return Result{}, fmt.Errorf("push: resolve node %s: %w", nodeID, err)
	}
	addr, ok := addrs[nodeID]
	if !ok || addr == "" {
		// Not an error condition to shout about: a node disappearing between the
		// presence read and here is ordinary, and the caller's response — skip
		// it, the outbox has the event — is the same either way.
		return Result{}, fmt.Errorf("%w: %s", ErrNodeUnreachable, nodeID)
	}

	res, err := t.client.Send(ctx, addr, batch)
	if err != nil {
		// The address came from a cache; a failure is the best evidence
		// available that it is stale. See AddrResolver.
		t.addrs.ForgetNodeAddr(nodeID)
		return res, err
	}
	return res, nil
}

// Compile-time proof the default implementation satisfies the interface. Cheap,
// and it fails at build time rather than at the one call site that constructs it.
var _ Transport = (*HTTPTransport)(nil)
