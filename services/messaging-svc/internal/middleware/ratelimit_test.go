package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// passthroughOK is a tiny handler that always 200s — used as the wrapped
// handler under test.
func passthroughOK() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestLimiter_AllowsUnderBudget(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 5, UserReadsPerMin: 10, UserWritesPerMin: 5})
	h := l.PerIPMiddleware(passthroughOK())

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "1.2.3.4:1111"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("req %d: got %d, want 200", i, rr.Code)
		}
	}
}

// Once the bucket is drained, the next request must 429 with the canonical body
// shape. This is the contract the frontend's ApiError parser depends on.
func TestLimiter_429AfterBudgetExceeded(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 2, UserReadsPerMin: 10, UserWritesPerMin: 5})
	h := l.PerIPMiddleware(passthroughOK())

	hit := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "9.9.9.9:1111"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}

	// Drain budget — burst of 2 plus a slow steady refill, but tight in time.
	for i := 0; i < 2; i++ {
		if got := hit(); got.Code != http.StatusOK {
			t.Fatalf("warmup req %d: got %d, want 200", i, got.Code)
		}
	}
	r3 := hit()
	if r3.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", r3.Code)
	}
	if r3.Header().Get("Retry-After") == "" {
		t.Error("missing Retry-After header on 429")
	}
	body := r3.Body.String()
	if !strings.Contains(body, `"code":"rate_limited"`) {
		t.Errorf("body missing canonical code; got %s", body)
	}
}

// Per-IP and per-user buckets must not bleed into each other — a chatty user
// shouldn't lock out an entire NAT, and a flood from one IP shouldn't lock
// out a single signed-in user behind it.
func TestLimiter_SeparatesIpAndUserBuckets(t *testing.T) {
	l := NewLimiter(Limits{IPPerMinute: 1000, UserReadsPerMin: 2, UserWritesPerMin: 2})
	uid := "user-abc"

	h := l.PerUserMiddleware(func(*http.Request) string { return uid })(passthroughOK())

	// 2 user reads succeed, 3rd 429s
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("req %d: got %d, want 200", i, rr.Code)
		}
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", rr.Code)
	}

	// Same IP, different user → fresh bucket.
	h2 := l.PerUserMiddleware(func(*http.Request) string { return "user-different" })(passthroughOK())
	rr2 := httptest.NewRecorder()
	h2.ServeHTTP(rr2, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr2.Code != http.StatusOK {
		t.Errorf("second user got 429 from first user's budget: got %d", rr2.Code)
	}
}

// When the extractor returns "" (anonymous request) the per-user middleware
// must fall through so the per-IP middleware can still cap it.
func TestLimiter_AnonymousFallsThrough(t *testing.T) {
	l := NewLimiter(Limits{UserReadsPerMin: 0})
	h := l.PerUserMiddleware(func(*http.Request) string { return "" })(passthroughOK())

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("anonymous request was blocked: got %d", rr.Code)
	}
}

// Writes get a tighter budget than reads — this test pins that distinction so
// nobody flips the budget the wrong way around in a refactor.
func TestLimiter_WritesUseWriteBudget(t *testing.T) {
	l := NewLimiter(Limits{UserReadsPerMin: 100, UserWritesPerMin: 1})
	h := l.PerUserMiddleware(func(*http.Request) string { return "u" })(passthroughOK())

	// First write OK
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("first write got %d, want 200", rr.Code)
	}
	// Second write blocked
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, httptest.NewRequest(http.MethodPost, "/", nil))
	if rr2.Code != http.StatusTooManyRequests {
		t.Errorf("second write got %d, want 429", rr2.Code)
	}
	// But a read still goes through because reads have their own budget.
	rr3 := httptest.NewRecorder()
	h.ServeHTTP(rr3, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr3.Code != http.StatusOK {
		t.Errorf("read got %d, want 200 (read budget should be independent)", rr3.Code)
	}
}

// Bounded-memory invariant: even under attack with unique keys, the per-shard
// cap must not be exceeded.
func TestLimiter_BoundedMemoryUnderUniqueKeyAttack(t *testing.T) {
	l := NewLimiter(DefaultLimits)
	for i := 0; i < maxPerShard*2; i++ {
		l.Allow("attack:"+itoa(i), 100)
	}
	total := 0
	for i := range l.shards {
		s := &l.shards[i] // take a pointer: ranging by value would copy the mutex
		s.mu.Lock()
		total += len(s.m)
		s.mu.Unlock()
	}
	if total > numShards*maxPerShard {
		t.Errorf("bucket count %d exceeds cap %d", total, numShards*maxPerShard)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
