package readcache

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The security property this package rests on, asserted rather than assumed.
//
// `user_projection` is RLS-protected and org-scoped (0007_rls.sql lists it in
// org_tables with ENABLE + FORCE ROW LEVEL SECURITY), so the DATABASE'S ANSWER
// to "who is user X" depends on who is asking — a caller in another org gets no
// row at all. A cache keyed on the user id alone silently erases that: a value
// populated under org A's GUC would be served to a request under org B's,
// handing org B a display name RLS exists to withhold.
//
// This is the same trap the signalling peer-check cache documents and tests for
// (keyed `org + user`, "keyed on the user alone, one legitimate same-org call
// would poison the cache into admitting every other org's traffic to that
// person"). The first draft of this package made exactly that mistake, which is
// why the assertion is here rather than left to review.

func TestUserKeyIsScopedToTheOrg(t *testing.T) {
	orgA := "11111111-1111-1111-1111-111111111111"
	orgB := "22222222-2222-2222-2222-222222222222"
	user := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

	if UserKey(orgA, user) == UserKey(orgB, user) {
		t.Fatal("the same user in two orgs shares a cache key — a name cached for " +
			"one organisation would be served to the other, defeating the RLS " +
			"policy on user_projection")
	}
}

func TestUserKeyContainsBothIdentifiers(t *testing.T) {
	// Guards a refactor that "simplifies" the key by dropping a component. Both
	// halves are load-bearing: the org for isolation, the user for correctness.
	org := "org-1"
	user := "user-1"
	key := UserKey(org, user)
	if !strings.Contains(key, org) {
		t.Errorf("key %q does not contain the org id", key)
	}
	if !strings.Contains(key, user) {
		t.Errorf("key %q does not contain the user id", key)
	}
}

func TestUserKeyIsNamespaced(t *testing.T) {
	// This Redis is shared with presence, the replay outbox, the node registry
	// and the rate-limit buckets. A prefix is what makes "what is the cache
	// costing me" answerable with --scan, and what stops a key collision with a
	// component that has never heard of this one.
	if !strings.HasPrefix(UserKey("o", "u"), "mc:") {
		t.Error("cache keys must be namespaced under mc: — the Redis instance is shared")
	}
}

// ── The nil-cache contract ───────────────────────────────────────────────────
//
// A nil *Cache is what makes REDIS_URL genuinely optional. Every call site uses
// the cache unconditionally, so if nil were not safe, each one would need a
// branch — and a missed branch is a nil dereference on the message send path.

func TestNilCacheIsUsable(t *testing.T) {
	var c *Cache // deliberately nil, as when REDIS_URL is unset
	ctx := context.Background()

	if c.Enabled() {
		t.Error("a nil cache reports itself enabled")
	}
	if err := c.Ping(ctx); err != nil {
		t.Errorf("Ping on a nil cache returned %v; it must be a no-op", err)
	}
	if err := c.Close(); err != nil {
		t.Errorf("Close on a nil cache returned %v; it must be a no-op", err)
	}

	// The operations must not panic and must report a miss, so the caller falls
	// through to the database exactly as it did before caching existed.
	if _, ok := GetJSON[string](ctx, c, UserKey("o", "u")); ok {
		t.Error("a nil cache reported a hit")
	}
	SetJSON(ctx, c, UserKey("o", "u"), "value", time.Minute)
	Del(ctx, c, UserKey("o", "u"))
}

func TestNewWithNoURLReturnsNoCache(t *testing.T) {
	// An unset REDIS_URL is the development default, not an error. Returning an
	// error here would make Redis mandatory by the back door.
	c, err := New("")
	if err != nil {
		t.Fatalf("New(\"\") returned %v; an absent URL is not an error", err)
	}
	if c.Enabled() {
		t.Error("New(\"\") produced an enabled cache")
	}
}

func TestNewRejectsAMalformedURL(t *testing.T) {
	// A typo must fail the boot rather than degrade silently. A cache that
	// always misses looks exactly like one that works, only slower — and slower
	// is the entire thing this package exists to fix, so the failure would hide
	// in the one signal anybody would use to detect it.
	if _, err := New("not-a-redis-url"); err == nil {
		t.Error("New accepted a malformed URL; a typo would leave every read " +
			"going to Postgres with no indication why")
	}
}

func TestTTLIsABackstopNotTheMechanism(t *testing.T) {
	// UserTTL only bounds how long a LOST invalidation can be wrong for — the
	// auth consumer invalidates on every rename. If it ever drops to something
	// short, that is a sign someone has started treating it as the correctness
	// mechanism, which would mean the invalidation path has been broken or
	// removed.
	if UserTTL < time.Minute {
		t.Errorf("UserTTL is %v — too short to be a backstop. If the explicit "+
			"invalidation in UpsertUser still works this should be minutes, not "+
			"seconds; if it does not, fix that rather than shortening this.", UserTTL)
	}
}
