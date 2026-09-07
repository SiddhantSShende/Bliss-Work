package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/task-board/ws-gateway/internal/metrics"
)

// ── Node registry ────────────────────────────────────────────────────────────
//
// Where routed delivery gets its routing table.
//
// Half of it already existed: `presence:u:<userId>` is a ZSET whose members are
// `nodeId:connId`, so "which nodes hold this user's sockets" is a read of a key
// the gateway has been maintaining all along. The missing half is turning a
// nodeId into somewhere to send a request, which is what these add.
//
// TTL-based, like presence and for the same reason: a pod that is SIGKILLed,
// OOM-killed or evicted runs no cleanup, so anything that depends on a
// deregistration step is wrong the first time a node dies badly. An entry that
// ages out on its own needs no such step. The registration is refreshed on a
// ticker; miss enough refreshes and the node stops being routable, which is
// exactly the desired behaviour for a node that has stopped.

const (
	// nodeTTL bounds how long a dead node stays routable. Pushes to it fail
	// during that window, which is harmless — the event is already in the
	// user's replay outbox and the client re-reads it on reconnect — but a
	// shorter window means fewer wasted requests.
	nodeTTL = 30 * time.Second

	// NodeHeartbeatInterval is how often a live node should re-register. Three
	// beats inside nodeTTL, so a single missed tick (a GC pause, a slow Redis)
	// does not deregister a healthy node.
	NodeHeartbeatInterval = 10 * time.Second
)

const (
	// nodeAddrCacheTTL is a third of nodeTTL. Short enough that a graceful
	// DeregisterNode still takes effect promptly, long enough that a call's
	// whole signalling burst — offer, answer and dozens of trickled ICE
	// candidates — resolves the peer's address once instead of per frame.
	nodeAddrCacheTTL = nodeTTL / 3

	// nodeAddrCacheMax bounds the map against pod churn over a long-lived
	// process. A fleet has tens to low hundreds of live nodes; this is room for
	// far more, and every entry is a UUID and a short URL.
	nodeAddrCacheMax = 4096
)

// Tagged like the rest, so that in cluster mode a node's address sits on a
// predictable slot rather than wherever the whole key happened to hash.
func (s *Store) nodeKey(nodeID string) string { return "node:" + s.tag(nodeID) }

// RegisterNode advertises this gateway as reachable at addr.
//
// Call on boot and then every NodeHeartbeatInterval. addr is a base URL the
// delivery service can actually reach — a pod IP in Kubernetes, a service name
// in compose — and NOT anything derived from the request, since the node is
// describing itself.
func (s *Store) RegisterNode(ctx context.Context, nodeID, addr string) (err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	return s.rdb.Set(ctx, s.nodeKey(nodeID), addr, nodeTTL).Err()
}

// DeregisterNode removes this node immediately.
//
// An optimisation on graceful shutdown, never a correctness requirement: the
// TTL is what actually guarantees removal, and this only shortens the window in
// which pushes are sent to a pod that has already drained its sockets.
func (s *Store) DeregisterNode(ctx context.Context, nodeID string) (err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	return s.rdb.Del(ctx, s.nodeKey(nodeID)).Err()
}

// NodesForUsers is NodesForUser for a whole recipient list, in one round trip.
//
// The batch form is not an optimisation, it is what makes routed delivery worth
// doing. One message into a thousand-member channel is a thousand recipients;
// asking Redis about each of them separately would replace the broadcast's
// wasted CPU with a thousand sequential round trips, which is a worse trade.
// Pipelining sends them together and reads the replies together.
//
// Users with no live socket are absent from the result rather than mapping to
// an empty slice — "nobody to route to" and "not in the map" are the same fact
// and the caller treats them the same way.
func (s *Store) NodesForUsers(ctx context.Context, userIDs []string) (out map[string][]string, err error) {
	out = make(map[string][]string, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	defer observe(metrics.PurposeNodes, time.Now(), &err)

	cutoff := fmt.Sprintf("%f", staleBefore())
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.StringSliceCmd, len(userIDs))
	for i, uid := range userIDs {
		cmds[i] = pipe.ZRangeByScore(ctx, s.presenceKey(uid), &redis.ZRangeBy{
			Min: cutoff,
			Max: "+inf",
		})
	}
	// redis.Nil is returned when SOME command in the pipeline found nothing,
	// which for a fan-out to a partly-offline audience is the normal case
	// rather than a failure. Any other error is real.
	//
	// Assigns the NAMED err, not a shadowed one — see AddOrgPresence and
	// OnlineAmong. This is the routing lookup on the delivery hot path, so a
	// failure recorded as a success is the one most worth not making: it is the
	// signal that says "events are not being routed". Cleared afterwards so the
	// ordinary redis.Nil is not counted as an error.
	if _, err = pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	err = nil

	for i, cmd := range cmds {
		members, cerr := cmd.Result()
		if cerr != nil {
			continue // this user has no live socket; the rest are still valid
		}
		seen := make(map[string]struct{}, len(members))
		var nodes []string
		for _, m := range members {
			nodeID, _, ok := strings.Cut(m, ":")
			if !ok || nodeID == "" {
				continue
			}
			if _, dup := seen[nodeID]; dup {
				continue
			}
			seen[nodeID] = struct{}{}
			nodes = append(nodes, nodeID)
		}
		if len(nodes) > 0 {
			out[userIDs[i]] = nodes
		}
	}
	return out, nil
}

// NodeAddrs resolves node ids to base URLs, reading Redis only for ids it has
// not seen recently.
//
// Nodes whose registration has expired are simply absent from the result rather
// than being an error: a node disappearing between the presence read and this
// lookup is ordinary, and the caller's response — skip it, the outbox has the
// event — is the same either way.
//
// ── Why caching this is not a staleness trade ────────────────────────────────
// A node id is a fresh UUID minted at process start, and RegisterNode only ever
// writes the same address under it. So the mapping is IMMUTABLE for the life of
// the node: a cached answer cannot be wrong in the way a cached presence lookup
// can, because there is no second value it could have become.
//
// The only thing the cache can miss is a node that has DIED — and the answer to
// that was already stale before, by up to nodeTTL, since a dead pod's key
// lingers until it expires. Caching for a fraction of nodeTTL keeps that window
// the same order of magnitude while removing a Redis round trip from every
// cross-node delivery. DeregisterNode on graceful shutdown becomes slightly less
// prompt, which it can afford: it was already documented as an optimisation on
// top of the TTL rather than a correctness requirement.
//
// Misses are NOT cached. An unregistered node is very often one that is about to
// register — a pod still booting — and remembering its absence would keep it
// unroutable for longer than the truth warrants.
func (s *Store) NodeAddrs(ctx context.Context, nodeIDs []string) (map[string]string, error) {
	if len(nodeIDs) == 0 {
		return map[string]string{}, nil
	}

	addrs := make(map[string]string, len(nodeIDs))
	var missing []string
	for _, id := range nodeIDs {
		if addr, ok := s.addrCache.Get(id); ok {
			addrs[id] = addr
			metrics.RouteCacheTotal.WithLabelValues(metrics.CacheNodeAddr, metrics.CacheHit).Inc()
			continue
		}
		metrics.RouteCacheTotal.WithLabelValues(metrics.CacheNodeAddr, metrics.CacheMiss).Inc()
		missing = append(missing, id)
	}
	if len(missing) == 0 {
		return addrs, nil
	}

	fetched, err := s.fetchNodeAddrs(ctx, missing)
	if err != nil {
		return nil, err
	}
	for id, addr := range fetched {
		s.addrCache.Put(id, addr)
		addrs[id] = addr
	}
	return addrs, nil
}

// ForgetNodeAddr drops a cached address. Called when a push to it failed, so the
// next delivery re-reads rather than retrying an address that may belong to a
// pod that has gone.
func (s *Store) ForgetNodeAddr(nodeID string) { s.addrCache.Forget(nodeID) }

func (s *Store) fetchNodeAddrs(ctx context.Context, nodeIDs []string) (addrs map[string]string, err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	// Pipelined GETs, not MGET. MGET requires every key to live in the same
	// slot, and node ids hash all over the keyspace — so under a cluster the
	// single-command form fails with CROSSSLOT exactly when the fleet is large
	// enough for this to matter. A pipeline is split per node by the cluster
	// client and costs the same one round trip per node it has to talk to.
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.StringCmd, len(nodeIDs))
	for i, id := range nodeIDs {
		cmds[i] = pipe.Get(ctx, s.nodeKey(id))
	}
	// redis.Nil here means at least one node's registration has expired, which
	// is ordinary — a pod restarting is exactly this. Any other error is real.
	if _, err = pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	err = nil
	addrs = make(map[string]string, len(nodeIDs))
	for i, cmd := range cmds {
		addr, cerr := cmd.Result()
		if cerr != nil || addr == "" {
			continue // expired between the presence read and here
		}
		addrs[nodeIDs[i]] = addr
	}
	return addrs, nil
}

// NOTE: the Redis pub/sub paths that used to live here are gone.
//
// RTC signalling used `PUBLISH rtc:user:<id>` against a channel every gateway
// matched with `PSUBSCRIBE rtc:user:*`, and presence used a single shared
// `presence:events` channel. Both were BROADCASTS: every node received every
// frame in the platform and discarded what it could not deliver, so cost scaled
// with node count rather than with traffic.
//
// Neither would have survived sharding either. Classic Redis pub/sub is
// delivered to every node of a cluster regardless of what the channel name
// hashes to, so moving Redis to a cluster would have divided none of that work.
//
// Both now route through the node registry above — NodesForUsers to find where
// a recipient's sockets are, NodeAddrs to reach those nodes, and a direct push.
// See internal/push/fanout.go.
