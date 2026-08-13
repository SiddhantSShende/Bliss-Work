// ratelimit.go: in-process token-bucket rate limiter for messaging-svc.
//
// Design notes:
//   - Per-IP bucket (RealIP middleware must run first) caps anonymous abuse.
//   - Per-user bucket (parsed from JWT after auth middleware) caps signed-in
//     abuse; one of the two will dominate depending on traffic shape.
//   - The bucket store is sharded with LRU eviction so a sustained attack
//     can't OOM us by minting unique keys.
//   - In-process (not Redis-backed) on purpose: at 1B DAU you'd front this
//     with an edge WAF + Redis Cluster (see INFRASTRUCTURE.md). Keeping it
//     in-process here means no failure mode where a Redis outage 500s every
//     request — fail-open is implicit because the limiter never sees Redis.
package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Bucket parameters. Reads are cheaper than writes; the token budget reflects
// that — a user can list-inbox 10x per second but only send messages ~2/sec.
type Limits struct {
	IPPerMinute      int
	UserReadsPerMin  int
	UserWritesPerMin int
}

// DefaultLimits is what the prod stack uses. Tweak via Limiter{Limits:...}.
var DefaultLimits = Limits{
	IPPerMinute:      300,
	UserReadsPerMin:  600,
	UserWritesPerMin: 120,
}

// keyShard caps total bucket count per shard. With 64 shards and 1024 entries
// each, we hold ~64k buckets — bounded memory under attack.
const (
	numShards     = 64
	maxPerShard   = 1024
	bucketTTL     = 5 * time.Minute
	sweepInterval = 1 * time.Minute
)

type bucket struct {
	lim       *rate.Limiter
	touchedAt time.Time
}

type shard struct {
	mu sync.Mutex
	m  map[string]*bucket
}

// Limiter holds the bucket store and per-call rate-allowance lookup. One
// instance shared across the whole router.
type Limiter struct {
	Limits Limits
	shards [numShards]shard
}

// NewLimiter constructs a Limiter with the given Limits (use DefaultLimits if
// you're not testing) and kicks off the periodic eviction goroutine.
func NewLimiter(l Limits) *Limiter {
	out := &Limiter{Limits: l}
	for i := range out.shards {
		out.shards[i].m = make(map[string]*bucket, 64)
	}
	go out.sweepLoop()
	return out
}

func (l *Limiter) shardFor(key string) *shard {
	var h uint32 = 2166136261
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= 16777619
	}
	return &l.shards[h%numShards]
}

// Allow records one event and returns whether it's permitted by the bucket
// keyed at `key`. perMin is the steady-state rate; the burst is set to the
// rate so a quiet caller can emit ~one minute of traffic at once.
func (l *Limiter) Allow(key string, perMin int) bool {
	s := l.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	b, ok := s.m[key]
	if !ok {
		// Evict eagerly if we've hit cap (cheap LRU-ish: drop the oldest).
		if len(s.m) >= maxPerShard {
			var oldestKey string
			var oldestAt time.Time
			for k, v := range s.m {
				if oldestKey == "" || v.touchedAt.Before(oldestAt) {
					oldestKey = k
					oldestAt = v.touchedAt
				}
			}
			delete(s.m, oldestKey)
		}
		b = &bucket{lim: rate.NewLimiter(rate.Every(time.Minute/time.Duration(perMin)), perMin)}
		s.m[key] = b
	}
	b.touchedAt = now
	return b.lim.Allow()
}

func (l *Limiter) sweepLoop() {
	t := time.NewTicker(sweepInterval)
	defer t.Stop()
	for now := range t.C {
		l.sweep(now)
	}
}

func (l *Limiter) sweep(now time.Time) {
	for i := range l.shards {
		s := &l.shards[i]
		s.mu.Lock()
		for k, v := range s.m {
			if now.Sub(v.touchedAt) > bucketTTL {
				delete(s.m, k)
			}
		}
		s.mu.Unlock()
	}
}

// clientIP identifies the caller for rate-limiting purposes.
//
// It reads the LAST entry of X-Forwarded-For, not the first. That distinction is
// the whole point: XFF is a list a client can pre-populate, and each proxy
// APPENDS the peer it actually saw. So the leftmost entry is whatever the client
// claimed, and only the rightmost was observed by our own edge.
//
// chi's middleware.RealIP used to do this job and took the leftmost value, which
// made this limiter trivially bypassable — send a different X-Forwarded-For on
// every request and every request lands in a fresh bucket, defeating a control
// whose entire job is stopping anonymous floods before JWT verification. That is
// the vulnerability behind RealIP's deprecation (GHSA-3fxj-6jh8-hvhx).
//
// TRUST MODEL: exactly one proxy hop (our Caddy edge) sits in front of this
// service, and nothing else can reach it — it is not published outside the
// compose network. If a second trusted proxy is ever added, this must skip that
// many entries from the right instead of one.
// ClientIP is clientIP for callers outside this package. Same trust model:
// only the rightmost X-Forwarded-For entry — the one our own edge observed —
// may be believed.
func ClientIP(r *http.Request) string { return clientIP(r) }

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// PerIPMiddleware caps requests by source IP. Use this as the outermost layer
// on the authed group so anonymous floods (token-spray, scrapers) are blocked
// before they ever hit JWT verification.
func (l *Limiter) PerIPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !l.Allow("ip:"+ip, l.Limits.IPPerMinute) {
			writeRateLimited(w, r, l.Limits.IPPerMinute)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// PerUserMiddleware caps requests by JWT subject. Writes (POST/PUT/PATCH/
// DELETE) are limited harder than reads, and they bucket independently — a
// chatty inbox-poller shouldn't lock the user out of sending a message. The
// extractor returns the user id from the verified JWT context; an empty
// string falls through (the per-IP limit already covered the anonymous case).
func (l *Limiter) PerUserMiddleware(userExtractor func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid := userExtractor(r)
			if uid == "" {
				next.ServeHTTP(w, r)
				return
			}
			key := "user:" + uid + ":r"
			budget := l.Limits.UserReadsPerMin
			if isWrite(r.Method) {
				key = "user:" + uid + ":w"
				budget = l.Limits.UserWritesPerMin
			}
			if !l.Allow(key, budget) {
				writeRateLimited(w, r, budget)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isWrite(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// writeRateLimited emits 429 + canonical body + Retry-After. The body shape
// matches packages/shared ApiErrorBody so the frontend toasts the same way
// for every kind of error.
func writeRateLimited(w http.ResponseWriter, r *http.Request, perMin int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "60") // one bucket window
	w.WriteHeader(http.StatusTooManyRequests)
	rid := RequestIDFromContext(r.Context())
	_, _ = w.Write([]byte(
		`{"error":{"code":"rate_limited","message":"too many requests","requestId":"` + rid + `"}}`,
	))
	_ = perMin // reserved for future per-route budget labels
}
