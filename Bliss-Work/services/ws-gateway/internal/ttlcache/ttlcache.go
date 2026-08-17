// Package ttlcache is a small bounded map with per-entry expiry, for facts that
// are read far more often than they change.
//
// It exists for the signalling hot path. Every rtc.* frame — and there are
// dozens per call setup, since ICE candidates trickle — used to make a Redis
// round trip to ask two questions whose answers do not change between one
// candidate and the next: is this peer a same-org online user, and what address
// reaches the node holding them. At the per-connection cap of 200 frames/second
// that is up to 600 Redis operations per second from a single socket.
//
// ── Deliberately not an LRU ──────────────────────────────────────────────────
// An LRU needs a linked list and a write lock on every READ to reorder it, which
// on a read-mostly cache costs more than it saves. Entries here expire on a
// timer instead, so reads take a read lock and never mutate. When the cache is
// full it prunes expired entries, and if that is not enough it drops everything
// and starts again.
//
// Dropping everything sounds crude, and would be for a cache holding expensive
// values. Here a miss is one Redis round trip — the cost of not having the cache
// at all — and entries live for seconds, so a full cache is a transient state
// that repopulates immediately. What it buys is a hard memory bound with no
// per-entry bookkeeping, which is the property that actually matters when the
// alternative is a map that grows with every peer any user ever signals.
package ttlcache

import (
	"sync"
	"time"
)

// Cache maps a string key to a value for a fixed duration.
//
// The zero value is not usable; call New. Safe for concurrent use.
type Cache[V any] struct {
	ttl time.Duration
	max int

	mu      sync.RWMutex
	entries map[string]entry[V]

	// now is time.Now in production and a stub in tests. Expiry is the whole
	// behaviour of this type, and a test that has to sleep to observe it is
	// slow and flaky in exactly the way that gets it deleted.
	now func() time.Time
}

type entry[V any] struct {
	val     V
	expires time.Time
}

// New returns a cache holding at most max entries for ttl each.
func New[V any](ttl time.Duration, max int) *Cache[V] {
	if max < 1 {
		max = 1
	}
	return &Cache[V]{
		ttl:     ttl,
		max:     max,
		entries: make(map[string]entry[V]),
		now:     time.Now,
	}
}

// Get returns the cached value and whether it was present and unexpired.
//
// An expired entry is reported as absent but left in place — removing it would
// need the write lock, and the caller is about to overwrite it with a fresh
// value anyway. Pruning is the job of the size bound in Put.
func (c *Cache[V]) Get(key string) (V, bool) {
	c.mu.RLock()
	e, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok || !c.now().Before(e.expires) {
		var zero V
		return zero, false
	}
	return e.val, true
}

// Put stores a value for the configured TTL.
func (c *Cache[V]) Put(key string, val V) {
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()

	// Only evict when full AND this is a new key: overwriting an existing entry
	// cannot grow the map, and evicting on that path would throw away a live
	// cache every time a hot key was refreshed.
	if _, exists := c.entries[key]; !exists && len(c.entries) >= c.max {
		c.pruneLocked(now)
		if len(c.entries) >= c.max {
			c.entries = make(map[string]entry[V])
		}
	}
	c.entries[key] = entry[V]{val: val, expires: now.Add(c.ttl)}
}

// Forget drops a key immediately. For the case where the caller has just
// learned the cached answer was wrong — a push to a cached address failing, say
// — and would rather pay for a fresh lookup than keep serving it.
func (c *Cache[V]) Forget(key string) {
	c.mu.Lock()
	delete(c.entries, key)
	c.mu.Unlock()
}

// Len reports how many entries are held, expired ones included.
func (c *Cache[V]) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}

func (c *Cache[V]) pruneLocked(now time.Time) {
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
}
