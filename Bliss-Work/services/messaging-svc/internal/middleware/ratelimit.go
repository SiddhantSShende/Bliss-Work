// ratelimit.go: token-bucket rate limiter for messaging-svc.
//
// Design notes:
//   - Per-IP bucket (RealIP middleware must run first) caps anonymous abuse.
//   - Per-user bucket (parsed from JWT after auth middleware) caps signed-in
//     abuse; one of the two will dominate depending on traffic shape.
//   - The bucket store is sharded with LRU eviction so a sustained attack
//     can't OOM us by minting unique keys.
//   - Buckets live in Redis when REDIS_URL is set, so the limit is one budget
//     across the fleet rather than one per pod, and fall back to the in-process
//     shards here whenever Redis cannot answer. See ratelimit_shared.go.
//
// This file used to argue for in-process buckets ONLY, on the grounds that a
// limiter which never sees Redis has no way to turn a Redis outage into a 500.
// The reasoning was sound and the conclusion was not: per-pod buckets mean a
// caller's real allowance is the configured one multiplied by the replica count,
// so the limit stopped meaning anything at exactly the scale it was written for.
// The availability argument is preserved instead of discarded — every Redis
// failure degrades to these buckets rather than failing the request, so the
// worst case is the behaviour this file used to have on purpose.
package middleware

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
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

	// shared is the fleet-wide bucket store. Nil means single-pod behaviour:
	// the in-process shards below are the whole limiter, exactly as before.
	// See ratelimit_shared.go for why it can only ever ADD accuracy and never
	// take away availability.
	shared *SharedStore
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

// WithShared makes the limiter fleet-wide, drawing every caller's tokens from
// one bucket in Redis instead of one per pod. A nil store leaves it per-pod.
func (l *Limiter) WithShared(s *SharedStore) *Limiter {
	l.shared = s
	return l
}

// Shared reports whether fleet-wide limiting is active, for a startup log. The
// difference is invisible from outside until someone counts requests, so it is
// worth saying out loud which one is running.
func (l *Limiter) Shared() bool { return l != nil && l.shared != nil }

func (l *Limiter) shardFor(key string) *shard {
	var h uint32 = 2166136261
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= 16777619
	}
	return &l.shards[h%numShards]
}

// Allow records one event against the in-process bucket keyed at `key`. perMin
// is the steady-state rate; the burst is set to the rate so a quiet caller can
// emit ~one minute of traffic at once.
//
// This is the per-pod path. Prefer AllowCtx, which consults the shared bucket
// first when one is configured and falls back to here when it cannot.
func (l *Limiter) Allow(key string, perMin int) bool {
	s := l.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	b, ok := s.m[key]
	if !ok {
		if len(s.m) >= maxPerShard {
			evictOne(s.m, now)
		}
		b = &bucket{lim: rate.NewLimiter(rate.Every(time.Minute/time.Duration(perMin)), perMin)}
		s.m[key] = b
	}
	b.touchedAt = now
	return b.lim.Allow()
}

// AllowCtx is Allow, consulting the fleet-wide bucket first.
//
// The fallback is the whole safety argument. Redis unreachable, slow, erroring
// or simply not configured all land in the same place: the in-process bucket
// that was the entire limiter before this existed. There is no path here that
// turns a Redis problem into a refused request.
//
// Note what is NOT done: the in-process bucket is not also debited on the shared
// path. Charging both would mean a single pod's local budget silently capping a
// caller below the fleet-wide limit they were granted, which is the per-pod bug
// this replaces wearing a different hat.
func (l *Limiter) AllowCtx(ctx context.Context, key string, perMin int) bool {
	if allowed, ok := l.shared.allow(ctx, key, perMin); ok {
		return allowed
	}
	return l.Allow(key, perMin)
}

// evictSample is how many entries a full shard inspects to pick a victim.
//
// ── Why sampling rather than "drop the oldest" ───────────────────────────────
// This used to scan the WHOLE shard — all 1,024 entries — under the shard mutex,
// on every request that minted a new key once the shard was full. That is an
// amplifier pointed at the exact traffic the limiter exists to stop: an
// IP-rotating flood mints a new key per request BY CONSTRUCTION, so each request
// paid a full map walk while holding a lock every other request on that shard
// was waiting for. The control got more expensive precisely as the attack got
// worse.
//
// Sampling a few entries and evicting the oldest of those is the standard trade
// (it is what Redis does for its own LRU): O(1) instead of O(shard), and the
// victim is only approximately the oldest — which costs nothing here, because
// the map is a bounded cache of token buckets and evicting a slightly-newer one
// just means that caller starts with a full bucket. The eviction is not a
// security boundary; the shared Redis bucket is.
//
// 8 samples make it very likely the victim is in the older part of the shard,
// and Go's map iteration order is randomised per range, so the sample is
// genuinely spread rather than always hitting the same slots.
const evictSample = 8

// evictOne removes approximately the least-recently-used entry.
//
// Prefers anything already past bucketTTL: those are dead regardless, so
// dropping one costs nothing at all and leaves the live entries alone.
func evictOne(m map[string]*bucket, now time.Time) {
	var victim string
	var victimAt time.Time
	seen := 0
	for k, v := range m {
		if now.Sub(v.touchedAt) > bucketTTL {
			delete(m, k) // already expired — the free win
			return
		}
		if victim == "" || v.touchedAt.Before(victimAt) {
			victim, victimAt = k, v.touchedAt
		}
		if seen++; seen >= evictSample {
			break
		}
	}
	if victim != "" {
		delete(m, victim)
	}
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
// TRUST MODEL: TRUSTED_PROXY_HOPS proxies sit in front of this service, and
// only the entry THEY observed may be believed.
//
// ── Why this is configurable now ─────────────────────────────────────────────
// This used to hardcode "skip exactly one entry from the right", with a comment
// saying that if a second trusted proxy were ever added, someone must come back
// and change the number. That is a latent failure with no error and no knob: a
// topology change — a load balancer in front of Caddy, an ingress that
// OVERWRITES rather than appends, a direct internal caller — silently turns the
// outermost anti-flood defence off, and nothing reports it.
//
// A load test made the shape concrete against a directly-reachable service:
// 500 requests from one source with no header → 212 rate-limited; 500 identical
// requests with a varying X-Forwarded-For → 0 rate-limited. Through Caddy this
// is safe, because Caddy APPENDS the address it observed, so the rightmost
// entry is Caddy's observation rather than the client's claim. Reachable
// directly, the client's claim is the only entry and it wins.
//
// The four Python services already take this as `TRUSTED_PROXY_HOPS` (see
// auth-svc/app/net.py), and the asymmetry was the actual defect: the same
// question answered two different ways in one platform, one of them with a
// number that cannot be changed without a code edit. This is deliberately the
// SAME semantics — count in from the right, fall back to the peer — so the two
// halves cannot drift.
//
// Setting it too HIGH is the dangerous direction: it starts believing entries a
// client supplied. Too low narrows the bucket to a proxy, which throttles
// everyone together — bad, but not a bypass.

// trustedProxyHops is how many proxies append to X-Forwarded-For before us.
// Read once at startup; TRUSTED_PROXY_HOPS=0 disables header parsing entirely
// and keys on the direct peer, which is correct for a service exposed with no
// proxy at all.
var trustedProxyHops = func() int {
	v := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_HOPS"))
	if v == "" {
		return 1 // the Caddy edge — the deployed topology
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 1
	}
	return n
}()

// SetTrustedProxyHops overrides the hop count. FOR TESTS ONLY — production
// reads the environment once at startup, because a limiter whose trust model
// can change at runtime is a limiter whose trust model can be changed.
func SetTrustedProxyHops(n int) { trustedProxyHops = n }

// ClientIP is clientIP for callers outside this package. Same trust model.
func ClientIP(r *http.Request) string { return clientIP(r) }

func clientIP(r *http.Request) string {
	if trustedProxyHops > 0 {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Index from the RIGHT: entries are appended by each proxy, so the
			// leftmost is whatever the client claimed and only the rightmost
			// hops were actually observed by infrastructure we run.
			parts := make([]string, 0, 4)
			for _, p := range strings.Split(xff, ",") {
				if p = strings.TrimSpace(p); p != "" {
					parts = append(parts, p)
				}
			}
			// Fewer entries than hops means the request did not traverse the
			// topology we expect. Falling back to the peer is the fail-SAFE
			// direction: it narrows the bucket rather than widening it to
			// something the caller chose.
			if len(parts) >= trustedProxyHops {
				if ip := parts[len(parts)-trustedProxyHops]; ip != "" {
					return ip
				}
			}
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
		if !l.AllowCtx(r.Context(), "ip:"+ip, l.Limits.IPPerMinute) {
			writeRateLimited(w, r, l.Limits.IPPerMinute)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// PerIPBudget caps by IP with an explicit allowance, in a bucket of its own.
//
// For a public route whose legitimate sender is a SERVICE rather than a
// browser, and which therefore has a completely different natural rate. The
// per-IP default is sized for a person clicking things; a machine reporting
// every participant and track event in every room on the deployment shares one
// source address and will exceed it while behaving perfectly normally.
//
// Still capped, and still by IP: the route is unauthenticated at the transport
// layer, so an allowance is what stops an open endpoint being an amplifier. The
// separate `name` keeps that budget from being spent by, or spending, the
// ordinary per-IP allowance for the same address.
func (l *Limiter) PerIPBudget(name string, perMinute int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.AllowCtx(r.Context(), name+":"+clientIP(r), perMinute) {
				writeRateLimited(w, r, perMinute)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
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
			if !l.AllowCtx(r.Context(), key, budget) {
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

// rateLimitedBody is the same envelope shape errors.go's apiErrorBody
// produces (packages/shared/src/types/errors.ts ApiErrorBody) — duplicated
// rather than imported, since internal/api already imports this package and
// importing back would cycle.
type rateLimitedBody struct {
	Error rateLimitedPayload `json:"error"`
}

type rateLimitedPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
}

// writeRateLimited emits 429 + canonical body + Retry-After.
func writeRateLimited(w http.ResponseWriter, r *http.Request, perMin int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "60") // one bucket window
	w.WriteHeader(http.StatusTooManyRequests)
	// json.Marshal, not string concatenation: rid is the caller-supplied
	// X-Request-Id header (requestid.go accepts anything up to 128 bytes with
	// no character filtering, by design — it exists to echo back whatever the
	// client sent). Splicing it into a hand-built JSON literal let a quote or
	// brace in that header inject arbitrary sibling keys into this response
	// body; Marshal escapes it like any other string value instead.
	body, err := json.Marshal(rateLimitedBody{Error: rateLimitedPayload{
		Code:      "rate_limited",
		Message:   "too many requests",
		RequestID: RequestIDFromContext(r.Context()),
	}})
	if err != nil {
		// Every field above is a plain string; Marshal cannot fail on this
		// shape. Fall back to a body with no requestId rather than 0 bytes.
		body = []byte(`{"error":{"code":"rate_limited","message":"too many requests"}}`)
	}
	_, _ = w.Write(body)
	_ = perMin // reserved for future per-route budget labels
}
