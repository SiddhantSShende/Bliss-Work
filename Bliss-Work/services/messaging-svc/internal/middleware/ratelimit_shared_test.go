package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// unreachableStore points the shared limiter at a closed port, with the tight
// timeouts NewSharedStore installs. It stands in for every way Redis can fail —
// down, unroutable, wedged — because the limiter treats them identically.
func unreachableStore(t *testing.T) *SharedStore {
	t.Helper()
	s, err := NewSharedStore("redis://127.0.0.1:1/0")
	if err != nil {
		t.Fatalf("NewSharedStore: %v", err)
	}
	if s == nil {
		t.Fatal("NewSharedStore returned nil for a non-empty URL")
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// ── Configuration ────────────────────────────────────────────────────────────

// No REDIS_URL is the single-pod and local-development case, and it must be a
// quiet nil rather than an error: the limiter is fully functional without it.
func TestNoURLYieldsNoStoreAndNoError(t *testing.T) {
	for _, url := range []string{"", "   ", ",", " , "} {
		s, err := NewSharedStore(url)
		if err != nil {
			t.Errorf("NewSharedStore(%q) errored: %v", url, err)
		}
		if s != nil {
			t.Errorf("NewSharedStore(%q) built a store from nothing", url)
		}
	}
}

// A malformed URL must fail loudly at construction. Swallowing it would leave
// the limiter permanently per-pod, which looks exactly like working correctly
// until somebody counts requests.
func TestMalformedURLIsAnError(t *testing.T) {
	// Note redis.ParseURL is more permissive than it looks — "redis://:pass@"
	// parses fine, defaulting the host — so this covers what it actually
	// rejects: a missing scheme and a scheme it does not speak.
	for _, url := range []string{"not-a-url", "http://redis:6379", "postgres://x/y"} {
		if _, err := NewSharedStore(url); err == nil {
			t.Errorf("NewSharedStore(%q) accepted a URL it cannot use", url)
		}
	}
}

func TestSeveralURLsBuildAClusterClient(t *testing.T) {
	s, err := NewSharedStore("redis://127.0.0.1:1/0, redis://127.0.0.2:1/0")
	if err != nil {
		t.Fatalf("NewSharedStore: %v", err)
	}
	defer func() { _ = s.Close() }()
	if s == nil || s.rdb == nil {
		t.Fatal("no client built from a comma-separated list")
	}
}

// Ping is what turns a silent misconfiguration into a startup log line.
func TestPingReportsAnUnreachableRedis(t *testing.T) {
	if err := unreachableStore(t).Ping(context.Background()); err == nil {
		t.Error("Ping succeeded against a closed port")
	}
}

// A nil store is the not-configured case and every method must tolerate it,
// because the alternative is a nil check at each of the call sites.
func TestNilStoreIsUsable(t *testing.T) {
	var s *SharedStore
	if err := s.Ping(context.Background()); err != nil {
		t.Errorf("Ping on a nil store: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Errorf("Close on a nil store: %v", err)
	}
	if allowed, ok := s.allow(context.Background(), "k", 60); ok || allowed {
		t.Error("a nil store answered a limit question instead of declining to")
	}
}

// ── The fallback, which is the whole safety argument ─────────────────────────

// THE PROPERTY THAT MATTERS MOST. An unreachable Redis must never turn into a
// refusal — the limiter would then be causing outages rather than preventing
// them. It degrades to the in-process bucket that was the entire limiter before
// the shared one existed.
func TestAnUnreachableRedisFallsBackAndStillAllows(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 10}).WithShared(unreachableStore(t))

	for i := 0; i < 5; i++ {
		if !l.AllowCtx(context.Background(), "ip:1.2.3.4", 10) {
			t.Fatalf("request %d refused because Redis is down", i+1)
		}
	}
}

// And the fallback must still LIMIT. Degrading to per-pod is the point;
// degrading to unlimited would quietly remove the protection at the moment an
// incident is most likely.
func TestTheFallbackStillEnforcesTheLimit(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 3}).WithShared(unreachableStore(t))

	const attempts = 10
	allowed := 0
	for i := 0; i < attempts; i++ {
		if l.AllowCtx(context.Background(), "ip:5.6.7.8", 3) {
			allowed++
		}
	}
	if allowed > 3 {
		t.Errorf("allowed %d of %d with a burst of 3 — the fallback is not limiting",
			allowed, attempts)
	}
	if allowed == 0 {
		t.Error("allowed none at all; the fallback bucket never issued its burst")
	}
}

// An already-cancelled request context must not be mistaken for a denial. The
// Redis call fails, and the fallback answers.
func TestACancelledContextFallsBackRatherThanRefusing(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 10}).WithShared(unreachableStore(t))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if !l.AllowCtx(ctx, "ip:9.9.9.9", 10) {
		t.Error("a cancelled context was treated as over the limit")
	}
}

// With no shared store at all, AllowCtx is exactly the old in-process limiter.
func TestWithoutASharedStoreBehaviourIsUnchanged(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 2})
	if l.Shared() {
		t.Error("Shared() is true with no store attached")
	}
	if !l.AllowCtx(context.Background(), "k", 2) || !l.AllowCtx(context.Background(), "k", 2) {
		t.Fatal("the first two requests within a burst of 2 were refused")
	}
	if l.AllowCtx(context.Background(), "k", 2) {
		t.Error("a third request was allowed against a burst of 2")
	}
}

func TestSharedReportsWhetherAStoreIsAttached(t *testing.T) {
	if NewLimiter(DefaultLimits).WithShared(unreachableStore(t)).Shared() != true {
		t.Error("Shared() is false with a store attached")
	}
	// Attaching a nil store is the not-configured path and must read as per-pod
	// rather than claiming a fleet-wide limit that is not there.
	if NewLimiter(DefaultLimits).WithShared(nil).Shared() {
		t.Error("Shared() is true after attaching a nil store")
	}
}

// The middlewares must inherit the fallback, not just AllowCtx — a limiter that
// is safe in isolation and 500s through the HTTP layer helps nobody.
func TestMiddlewareServesRequestsWhileRedisIsDown(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 100, UserReadsPerMin: 100, UserWritesPerMin: 100}).
		WithShared(unreachableStore(t))
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handlers := map[string]http.Handler{
		"per-ip":   l.PerIPMiddleware(ok),
		"per-user": l.PerUserMiddleware(func(*http.Request) string { return "u-1" })(ok),
	}
	for name, h := range handlers {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s returned %d with Redis unreachable, want 200", name, rec.Code)
		}
	}
}
