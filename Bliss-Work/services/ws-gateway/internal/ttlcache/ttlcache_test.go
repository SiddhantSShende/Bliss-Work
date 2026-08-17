package ttlcache

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// clock lets the expiry tests assert on behaviour instead of sleeping.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestCache[V any](ttl time.Duration, max int) (*Cache[V], *clock) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	cache := New[V](ttl, max)
	cache.now = c.now
	return cache, c
}

func TestGetReturnsWhatWasPut(t *testing.T) {
	c, _ := newTestCache[string](time.Minute, 10)
	c.Put("k", "v")

	got, ok := c.Get("k")
	if !ok || got != "v" {
		t.Errorf(`Get("k") = %q, %v; want "v", true`, got, ok)
	}
	if _, ok := c.Get("absent"); ok {
		t.Error("a key that was never put reported as present")
	}
}

// The entire point of the type. A value must stop being served the moment its
// TTL is up — the caller is trading staleness for round trips and needs the
// staleness bound to be the one it asked for.
func TestValuesExpireExactlyAtTheTTL(t *testing.T) {
	c, clk := newTestCache[int](10*time.Second, 10)
	c.Put("k", 1)

	clk.advance(9 * time.Second)
	if _, ok := c.Get("k"); !ok {
		t.Error("entry expired early, before its TTL elapsed")
	}
	clk.advance(time.Second) // exactly at the TTL
	if _, ok := c.Get("k"); ok {
		t.Error("entry still served AT its expiry; the staleness bound must be inclusive")
	}
}

func TestPutRefreshesTheDeadline(t *testing.T) {
	c, clk := newTestCache[int](10*time.Second, 10)
	c.Put("k", 1)
	clk.advance(9 * time.Second)
	c.Put("k", 2) // re-read from the source, cached again

	clk.advance(9 * time.Second)
	got, ok := c.Get("k")
	if !ok || got != 2 {
		t.Errorf("Get = %v, %v; want 2, true — a refresh must restart the TTL", got, ok)
	}
}

// The memory bound is the reason this is not just a map. Without it, a cache
// keyed by peer pair grows with every peer any user has ever signalled, for the
// life of the process.
func TestSizeIsBounded(t *testing.T) {
	c, _ := newTestCache[int](time.Hour, 10) // long TTL: nothing prunes
	for i := 0; i < 500; i++ {
		c.Put(fmt.Sprintf("k%d", i), i)
	}
	if n := c.Len(); n > 10 {
		t.Errorf("holding %d entries with max 10 — the bound is not enforced", n)
	}
	// And it is still usable afterwards, rather than wedged.
	c.Put("fresh", 42)
	if got, ok := c.Get("fresh"); !ok || got != 42 {
		t.Errorf("Get after overflow = %v, %v; want 42, true", got, ok)
	}
}

// Expired entries must be reclaimed before anything live is dropped, so a cache
// under steady churn keeps serving rather than resetting on every insert.
func TestFullCacheReclaimsExpiredEntriesBeforeDroppingLiveOnes(t *testing.T) {
	c, clk := newTestCache[int](10*time.Second, 4)
	for i := 0; i < 4; i++ {
		c.Put(fmt.Sprintf("old%d", i), i)
	}
	clk.advance(11 * time.Second) // every entry is now expired
	c.Put("live", 99)

	if got, ok := c.Get("live"); !ok || got != 99 {
		t.Errorf("Get(live) = %v, %v; want 99, true", got, ok)
	}
	if n := c.Len(); n > 1 {
		t.Errorf("kept %d entries; the expired ones should have been pruned to make room", n)
	}
}

// Overwriting a key cannot grow the map, so it must not trigger eviction —
// otherwise a hot key refreshing itself would repeatedly wipe the whole cache.
func TestRefreshingAKeyInAFullCacheKeepsTheOthers(t *testing.T) {
	c, _ := newTestCache[int](time.Hour, 3)
	c.Put("a", 1)
	c.Put("b", 2)
	c.Put("c", 3)

	c.Put("a", 10) // full, but not a new key

	for _, k := range []string{"a", "b", "c"} {
		if _, ok := c.Get(k); !ok {
			t.Errorf("%q was evicted by a refresh of an existing key", k)
		}
	}
}

func TestForgetDropsTheEntry(t *testing.T) {
	c, _ := newTestCache[int](time.Hour, 10)
	c.Put("k", 1)
	c.Forget("k")
	if _, ok := c.Get("k"); ok {
		t.Error("Forget left the entry readable")
	}
	c.Forget("never-existed") // must not panic
}

func TestZeroMaxIsClampedRatherThanPanicking(t *testing.T) {
	c := New[int](time.Hour, 0)
	c.Put("k", 1) // a max of 0 would make the map unusable or divide by zero
	if c.Len() < 1 {
		t.Error("a cache built with max 0 stores nothing at all")
	}
}

// The signalling path reads this from every socket's goroutine at once.
func TestConcurrentUseIsSafe(t *testing.T) {
	c := New[int](time.Minute, 100)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 500; j++ {
				key := fmt.Sprintf("k%d", j%50)
				c.Put(key, n)
				c.Get(key)
				if j%100 == 0 {
					c.Forget(key)
					c.Len()
				}
			}
		}(i)
	}
	wg.Wait()
}
