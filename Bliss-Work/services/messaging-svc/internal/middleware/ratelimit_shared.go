// ratelimit_shared.go: the fleet-wide half of the rate limiter.
//
// ── The problem this fixes ───────────────────────────────────────────────────
// The limiter in ratelimit.go keeps its buckets in process memory. That is
// correct for exactly one pod. With N pods behind a load balancer, a caller's
// real allowance is N times the configured one — 120 writes a minute becomes
// 1,200 across ten pods — and worse, it is NON-DETERMINISTIC, because what a
// caller actually gets depends on how the balancer happened to spread their
// requests. A limit that means a different thing on every deployment is not a
// limit; it is a number in a config file.
//
// It matters most for the PER-USER buckets. An edge WAF can rate-limit by IP
// and should, but it cannot parse our JWT, so "this user may write 120 times a
// minute" is a rule only this service can enforce — and it was the rule that
// dissolved as the fleet grew.
//
// ── Why this does not reintroduce a Redis dependency ─────────────────────────
// The original design note argued for in-process specifically so that a Redis
// outage could not turn into a 500 on every request. That concern is right and
// is answered rather than ignored: every Redis failure here — unreachable, slow,
// erroring, missing — falls through to the in-process bucket that was already
// there. Redis being down degrades the limiter from fleet-wide to per-pod, which
// is precisely where it started. It can never fail the request.
//
// The timeout is deliberately tighter than any sensible Redis latency, because
// the cost of waiting is paid by a request that has nothing to do with Redis.
package middleware

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisTimeout bounds one limiter round trip. A limiter that makes requests
// slower than the work they are limiting has stopped being a protection.
const redisTimeout = 100 * time.Millisecond

// bucketTTLSeconds is how long an idle bucket survives in Redis. Longer than
// the refill time of a full bucket, so an entry is only ever dropped once it
// would have refilled to full anyway and the state is worth nothing.
const bucketTTLSeconds = 300

// tokenBucket is the same algorithm as the in-process limiter, moved into
// Redis so every pod draws from ONE bucket per caller.
//
// A token bucket rather than the simpler INCR-with-expiry fixed window, for two
// reasons. It matches what the in-process fallback does, so a Redis blip changes
// where the limit applies but not how it behaves. And a fixed window lets a
// caller spend a full allowance at the end of one window and another at the
// start of the next — twice the intended rate, at the exact moment a flood is
// most likely.
//
// Time comes from redis.call('TIME'), not from the caller. Pods do not share a
// clock, and a bucket refilled against whichever pod's clock ran fastest would
// hand that pod's users a larger allowance. Taking it from the one process every
// pod already agrees on removes the question.
var tokenBucket = redis.NewScript(`
local key   = KEYS[1]
local rate  = tonumber(ARGV[1])   -- tokens per second
local burst = tonumber(ARGV[2])
local ttl   = tonumber(ARGV[3])

local t   = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000

local state  = redis.call('HMGET', key, 'n', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])
if tokens == nil or ts == nil then
  -- First sight of this caller: a full bucket, so a quiet caller is never
  -- penalised for the limiter not having heard of them yet.
  tokens = burst
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed * rate)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'n', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return allowed
`)

// SharedStore is the Redis half of the limiter. Nil when no REDIS_URL is
// configured, which is the single-pod and local-development case.
type SharedStore struct {
	rdb redis.UniversalClient
}

// NewSharedStore builds the Redis-backed half from one URL, or several comma
// separated for a cluster — the same spelling ws-gateway's REDIS_URL accepts, so
// there is one thing to learn rather than two.
//
// Each bucket is a single key, so nothing here spans slots and cluster mode
// needs no hash tags.
func NewSharedStore(redisURL string) (*SharedStore, error) {
	urls := splitRedisURLs(redisURL)
	if len(urls) == 0 {
		return nil, nil
	}
	opt, err := redis.ParseURL(urls[0])
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	// Bound every stage. A limiter that blocks is worse than one that is absent:
	// absent costs accuracy, blocking costs the request.
	opt.DialTimeout = redisTimeout
	opt.ReadTimeout = redisTimeout
	opt.WriteTimeout = redisTimeout

	if len(urls) == 1 {
		return &SharedStore{rdb: redis.NewClient(opt)}, nil
	}
	addrs := make([]string, 0, len(urls))
	for _, u := range urls {
		o, perr := redis.ParseURL(u)
		if perr != nil {
			return nil, fmt.Errorf("parse redis url %q: %w", u, perr)
		}
		addrs = append(addrs, o.Addr)
	}
	return &SharedStore{rdb: redis.NewClusterClient(&redis.ClusterOptions{
		Addrs:        addrs,
		Username:     opt.Username,
		Password:     opt.Password,
		TLSConfig:    opt.TLSConfig,
		DialTimeout:  redisTimeout,
		ReadTimeout:  redisTimeout,
		WriteTimeout: redisTimeout,
	})}, nil
}

func splitRedisURLs(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Ping proves the connection at startup so a typo in REDIS_URL is a boot-time
// log line rather than a silent, permanent fallback to per-pod limiting — which
// looks exactly like working correctly until someone counts the requests.
func (s *SharedStore) Ping(ctx context.Context) error {
	if s == nil {
		return nil
	}
	return s.rdb.Ping(ctx).Err()
}

func (s *SharedStore) Close() error {
	if s == nil {
		return nil
	}
	return s.rdb.Close()
}

// allow runs one token against the shared bucket.
//
// Returns (allowed, ok). ok=false means Redis could not answer and the caller
// must fall back — it is NEVER a denial. Refusing a request because a limiter's
// backing store is unwell would be the limiter causing the outage it exists to
// prevent.
func (s *SharedStore) allow(ctx context.Context, key string, perMin int) (allowed, ok bool) {
	if s == nil || perMin <= 0 {
		return false, false
	}
	ctx, cancel := context.WithTimeout(ctx, redisTimeout)
	defer cancel()

	res, err := tokenBucket.Run(ctx, s.rdb, []string{"rl:" + key},
		float64(perMin)/60.0, perMin, bucketTTLSeconds).Int64()
	if err != nil {
		return false, false
	}
	return res == 1, true
}
