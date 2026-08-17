package store

import (
	"context"
	"testing"
)

// The node-address cache, tested without a Redis on purpose.
//
// Pointing the Store at a closed port makes "did this reach Redis" directly
// observable: a lookup that is served from cache returns an address, and one
// that is not returns an error. That is a sharper assertion than counting
// commands against a live server, and it needs no broker to run.

func cacheTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New("redis://127.0.0.1:1/0?dial_timeout=100ms&read_timeout=100ms")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestNodeAddrsServesCachedEntriesWithoutTouchingRedis(t *testing.T) {
	s := cacheTestStore(t)
	s.addrCache.Put("n1", "http://10.0.0.1:8080")

	addrs, err := s.NodeAddrs(context.Background(), []string{"n1"})
	if err != nil {
		t.Fatalf("NodeAddrs errored with an entry cached: %v — it reached Redis anyway", err)
	}
	if addrs["n1"] != "http://10.0.0.1:8080" {
		t.Errorf("addrs = %v, want the cached address", addrs)
	}
}

// The other half: without a cached entry it must go to the source. A cache that
// silently answers "not registered" for everything it has not seen would make
// every node unroutable.
func TestNodeAddrsReadsThroughOnAMiss(t *testing.T) {
	s := cacheTestStore(t)
	if _, err := s.NodeAddrs(context.Background(), []string{"unknown"}); err == nil {
		t.Error("NodeAddrs succeeded for an uncached node with Redis unreachable — " +
			"it answered from nothing rather than reading through")
	}
}

// A partial hit still has to fetch the rest, rather than returning what it
// happens to hold. Half a routing table looks like half the fleet being down.
func TestNodeAddrsFetchesTheUncachedRemainder(t *testing.T) {
	s := cacheTestStore(t)
	s.addrCache.Put("cached", "http://10.0.0.1:8080")

	if _, err := s.NodeAddrs(context.Background(), []string{"cached", "uncached"}); err == nil {
		t.Error("a batch with one cached and one uncached id returned without " +
			"consulting Redis for the uncached one")
	}
}

func TestForgetNodeAddrSendsTheNextLookupBackToRedis(t *testing.T) {
	s := cacheTestStore(t)
	s.addrCache.Put("n1", "http://10.0.0.1:8080")
	s.ForgetNodeAddr("n1")

	if _, err := s.NodeAddrs(context.Background(), []string{"n1"}); err == nil {
		t.Error("the entry was still served after ForgetNodeAddr")
	}
}

func TestNodeAddrsWithNoIDsDoesNothing(t *testing.T) {
	s := cacheTestStore(t)
	addrs, err := s.NodeAddrs(context.Background(), nil)
	if err != nil || len(addrs) != 0 {
		t.Errorf("NodeAddrs(nil) = %v, %v; want an empty map and no error", addrs, err)
	}
}

// The cache TTL has to stay well inside the registration TTL. If it drew level,
// a cached address could outlive the registration that produced it and pushes
// would keep going to a pod that Redis has already forgotten — with no read
// left that would notice.
func TestCacheTTLIsWellInsideTheRegistrationTTL(t *testing.T) {
	if nodeAddrCacheTTL >= nodeTTL {
		t.Fatalf("nodeAddrCacheTTL (%v) must be shorter than nodeTTL (%v)",
			nodeAddrCacheTTL, nodeTTL)
	}
	if nodeAddrCacheTTL > nodeTTL/2 {
		t.Errorf("nodeAddrCacheTTL (%v) is more than half of nodeTTL (%v) — "+
			"a graceful DeregisterNode would take most of the registration window "+
			"to take effect, which is the thing it exists to avoid",
			nodeAddrCacheTTL, nodeTTL)
	}
}

// Every constructor path must build the cache. A nil one would panic on the
// first signalling frame, in production, at the moment the fleet grew past one
// pod — the worst possible time to discover it.
func TestBothConstructorPathsBuildTheCache(t *testing.T) {
	single, err := New("redis://127.0.0.1:1/0")
	if err != nil {
		t.Fatalf("single-node New: %v", err)
	}
	defer func() { _ = single.Close() }()
	if single.addrCache == nil {
		t.Error("the single-node path left the address cache nil")
	}

	cluster, err := New("redis://127.0.0.1:1/0,redis://127.0.0.2:1/0")
	if err != nil {
		t.Fatalf("cluster New: %v", err)
	}
	defer func() { _ = cluster.Close() }()
	if cluster.addrCache == nil {
		t.Error("the cluster path left the address cache nil")
	}
	if !cluster.Clustered() {
		t.Error("two URLs did not produce a cluster client")
	}
}
