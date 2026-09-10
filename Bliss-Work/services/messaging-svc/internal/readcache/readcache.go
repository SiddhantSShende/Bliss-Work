// Package readcache is the platform's first read cache.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Redis held presence, the replay outbox, the node registry and rate-limit
// buckets — and nothing else. Not one read path in any of the eight services
// was cached, so every channel list, message page, inbox render and profile
// lookup went to the single Postgres primary. At chat read/write ratios that is
// the largest single multiplier available, and it costs less than any
// infrastructure change on the roadmap.
//
// ── What is cached here, and why only this ───────────────────────────────────
// `user_projection` name lookups, and GetMail (see MailKey). Both were chosen
// because they are hot and — decisively — because each has an EXPLICIT
// INVALIDATION SIGNAL rather than only a TTL.
//
// These rows are read on every message send (to stamp the sender's name onto
// the event) and on every message list render, and they change only when
// auth-svc emits user.created / renamed / deactivated — which this service
// already consumes, so the consumer invalidates precisely.
//
// A TTL alone would have forced a choice between a stale name and a useless hit
// rate. Because there is a real invalidation signal, the TTL becomes a backstop
// for a LOST invalidation (a crash between the database write and the DEL)
// rather than the primary correctness mechanism. That is what lets it be long
// enough to be worth having.
//
// ── Keyed on org AND user, which is the security property ────────────────────
// `user_projection` is RLS-protected: 0007_rls.sql lists it in `org_tables`
// with ENABLE + FORCE ROW LEVEL SECURITY, and every read runs under the
// caller's `app.org_id` GUC. So the database's answer to "who is user X"
// DEPENDS ON WHO IS ASKING — a caller in another org gets no row at all.
//
// A cache keyed on user id alone would erase that. A lookup performed under
// org A's GUC would be served to a request under org B's, handing org B a
// display name RLS exists to hide. It is the same trap INFRASTRUCTURE.md
// documents for the signalling peer-check cache, which is keyed `org + user`
// for exactly this reason and has a test saying so. This one does too
// (readcache_test.go).
//
// ── What is deliberately NOT cached ──────────────────────────────────────────
// The hot inbox and thread reads — GET /inbox, GET /inbox/peers, thread
// listings — which are FEEDS: they change on every new arrival, and a stale
// read means a message the user just sent or received looks missing. Caching
// those reintroduces exactly the bug the read-replica work was careful to
// avoid, and it is the reason there is no blanket "cache all reads" switch
// here — every call site opts in individually. GetMail is not a feed (see
// MailKey) — it is a single item whose content stops changing once sent —
// which is what makes it a different, safe case rather than an exception to
// this rule.
//
// CHANNEL ROSTERS ARE NOT CACHED, and that is a deliberate reversal. They look
// like the ideal candidate — hot, small, tolerant of staleness — and the
// roadmap named them first. But of the five `channelMemberIDs` call sites, four
// compute FAN-OUT RECIPIENTS (SendChannelMessage, emitChannelEvent,
// forward_link_write, InternalChannelMembership) and only one is a genuine read
// that renders a member list. A stale roster on any of those four keeps
// delivering messages to somebody who has just been removed from the channel.
//
// That also contradicts a stance the platform states explicitly: Stage 9's
// whole argument for re-deciding call access from the database on every token
// mint is that removal has to take effect immediately. Caching the roster would
// undo that one rung down. The single safe call site is not worth a helper that
// the next fan-out path would reach for by name.
//
// ── Failure posture ──────────────────────────────────────────────────────────
// Every failure is a MISS, never an error. A cache that can fail a request has
// made the system less available than having no cache at all — the same
// argument the rate limiter makes for degrading to per-pod buckets rather than
// refusing traffic. There is no code path here that returns an error to a
// caller.
package readcache

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// timeout bounds one cache round trip.
//
// Deliberately tighter than any sensible Redis latency. The whole point of the
// cache is to be faster than Postgres; a lookup that waits longer than the
// query it is replacing has made the request slower AND still has to run the
// query. On timeout we treat it as a miss and go to the database, which is
// exactly what would have happened without a cache.
const timeout = 50 * time.Millisecond

// poolSize is set explicitly rather than left at go-redis's default
// (10 * runtime.GOMAXPROCS(0)).
//
// That default is fine on an unconstrained host, but this service's prod
// container is capped at 1 CPU (docker-compose.prod.yml), and since Go 1.25
// the runtime sets GOMAXPROCS from the container's own cgroup quota
// automatically (this module targets go 1.26) — so the "default" pool in
// production was quietly 10*1 = 10 connections, an accident of container
// sizing that nobody chose, not the deliberately-reasoned figure the
// Postgres pool in store.go is.
//
// Measured (scratch Redis, 1000 concurrent GetMail cache hits, prod's actual
// accidental PoolSize=10 as the baseline): PoolSize=10 → ~36-38ms p50;
// 100 → ~18-28ms; 150 → ~11-13ms; 200 → ~15-30ms (noisier, no longer a clear
// win over 150). 150 sits in the middle of the measured sweet spot without
// being close to the point (500-1000, tested separately) where over-widening
// the pool made things WORSE — the same non-monotonic shape the Postgres pool
// experiment showed, for the same reason: more concurrently-open connections
// past a point costs more in scheduling/dial overhead than it buys in
// reduced queuing.
const poolSize = 150

// UserTTL is a BACKSTOP, not the correctness mechanism — the cache is
// invalidated explicitly when auth-svc reports a change (see the package
// comment), so this only bounds how long a LOST invalidation can be wrong for.
//
// Long, because user_projection rows change rarely (a rename, a deactivation)
// and every one of those changes invalidates. Ten minutes of a stale display
// name after a dropped DEL is a cosmetic error with no authorization component:
// the key is org-scoped, so a stale entry can only ever be a name the caller
// was already entitled to see.
const UserTTL = 10 * time.Minute

// Cache is a namespaced read-through cache over Redis.
//
// A nil *Cache is fully usable and always misses. That is what makes REDIS_URL
// genuinely optional: every call site can use the cache unconditionally, and a
// deployment without Redis behaves exactly as it did before this package
// existed, with no branch at any call site to get wrong.
type Cache struct {
	rdb redis.UniversalClient
}

// New builds a Cache from one redis:// URL, or several comma-separated for a
// cluster — the same spelling ws-gateway's REDIS_URL accepts, so there is one
// thing to learn rather than two.
//
// Returns (nil, nil) for an empty URL: no Redis configured is not an error, it
// is the single-node development default.
func New(redisURL string) (*Cache, error) {
	urls := splitURLs(redisURL)
	if len(urls) == 0 {
		return nil, nil
	}
	opt, err := redis.ParseURL(urls[0])
	if err != nil {
		return nil, err
	}
	// Bound every stage. A cache that blocks is worse than one that is absent:
	// absent costs a database query, blocking costs the request.
	opt.DialTimeout = timeout
	opt.ReadTimeout = timeout
	opt.WriteTimeout = timeout
	opt.PoolSize = poolSize

	if len(urls) == 1 {
		return &Cache{rdb: redis.NewClient(opt)}, nil
	}
	addrs := make([]string, 0, len(urls))
	for _, u := range urls {
		o, perr := redis.ParseURL(u)
		if perr != nil {
			return nil, perr
		}
		addrs = append(addrs, o.Addr)
	}
	return &Cache{rdb: redis.NewClusterClient(&redis.ClusterOptions{
		Addrs:        addrs,
		Username:     opt.Username,
		Password:     opt.Password,
		TLSConfig:    opt.TLSConfig,
		DialTimeout:  timeout,
		ReadTimeout:  timeout,
		WriteTimeout: timeout,
		// Cluster PoolSize is per-node (see the field's own doc), which is
		// the right unit here too: each shard should get the same per-
		// connection budget a single-node deployment gets, not a fraction of
		// it split across shards.
		PoolSize: poolSize,
	})}, nil
}

func splitURLs(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Enabled reports whether a cache is actually configured, for a startup log.
// The difference is invisible from outside until someone counts queries, so it
// is worth saying out loud which one is running.
func (c *Cache) Enabled() bool { return c != nil && c.rdb != nil }

// Ping proves the connection at startup so a typo in REDIS_URL is a boot-time
// log line rather than a permanent silent miss — which looks exactly like
// working correctly, only slower.
func (c *Cache) Ping(ctx context.Context) error {
	if !c.Enabled() {
		return nil
	}
	return c.rdb.Ping(ctx).Err()
}

// Close releases the client.
func (c *Cache) Close() error {
	if !c.Enabled() {
		return nil
	}
	return c.rdb.Close()
}

// ── Keys ─────────────────────────────────────────────────────────────────────
//
// Prefixed `mc:` (messaging cache) so this keyspace is distinguishable at a
// glance from presence, the replay outbox and the rate-limit buckets, which
// share the instance. `redis-cli --scan --pattern 'mc:*'` answers "what is the
// cache costing me" without a guess.
//
// Not hash-tagged. Every operation here is single-key, so nothing spans slots
// and cluster mode needs no tags — and adding them would rename the keyspace
// for no benefit.

// UserKey is the cache key for one user_projection row, as seen BY A GIVEN ORG.
//
// The org id is not decoration and must never be dropped. `user_projection` is
// RLS-protected and org-scoped, so the database's answer to "who is user X"
// depends on who is asking — a caller in another org gets no row. Keyed on the
// user alone, a value cached for org A would be served to org B, handing it a
// display name RLS exists to withhold.
//
// Order is org-then-user so `--scan --pattern 'mc:up:<orgId>:*'` enumerates one
// organisation's cached names, which is what an operator asks for.
func UserKey(orgID, userID string) string { return "mc:up:" + orgID + ":" + userID }

// MailKey is the cache key for one GetMail response, as seen by ONE reader.
//
// Keyed org+mail+reader, not just org+mail: GetMail's own response differs by
// caller on two fields — Folder (SENT for the author, INBOX for a recipient of
// the same mail) and ReadAt (each recipient has their own mail_deliveries row
// and their own read timestamp) — so two different readers of the same mail
// are two different cache entries, the same way UserKey's org scoping exists
// because the answer depends on who is asking.
//
// This is deliberately NOT the same class of cache the package comment above
// rules out ("the hot inbox and thread reads"). Those are FEEDS — they change
// on every new arrival, and a stale read means a message the user just sent
// or received appears to be missing. GetMail is a single item: once a mail
// reaches SENT or RECEIVED its content never changes again (no edit-after-
// send), so the only mutable field is ReadAt, and the one write that changes
// it (MarkMailRead) invalidates this exact key immediately — see
// store.MarkMailRead. A DRAFT is mutable (autosave) and is never cached at
// all; see store.GetMail.
func MailKey(orgID, mailID, userID string) string { return "mc:mail:" + orgID + ":" + mailID + ":" + userID }

// MailTTL is a backstop for a lost invalidation (the same role UserTTL
// plays), not the primary correctness mechanism — MarkMailRead deletes the
// key explicitly. Shorter than UserTTL: unlike a display name, a missed
// invalidation here means a mail looks unread a little longer than it should,
// which is a more visible (if still harmless) staleness than a stale name.
const MailTTL = 5 * time.Minute

// ── Operations ───────────────────────────────────────────────────────────────

// GetJSON reads and unmarshals a cached value. `ok` is false for a miss, a
// timeout, an unreachable Redis, or a value that no longer parses — all of
// which mean the same thing to the caller: go and ask the database.
//
// A value that fails to unmarshal is treated as a miss rather than an error
// because the usual cause is a struct whose shape changed between deploys, and
// during a rolling deploy both shapes are in the keyspace at once. Missing and
// rewriting is correct; erroring would fail requests for the length of the
// rollout.
func GetJSON[T any](ctx context.Context, c *Cache, key string) (val T, ok bool) {
	var zero T
	if !c.Enabled() {
		return zero, false
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	raw, err := c.rdb.Get(ctx, key).Bytes()
	if err != nil {
		return zero, false // redis.Nil (a miss) and a real failure are the same answer
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		return zero, false
	}
	return out, true
}

// SetJSON stores a value. Best-effort: a failure to populate the cache is
// invisible to the caller, because the only consequence is the next read
// missing too.
func SetJSON(ctx context.Context, c *Cache, key string, val any, ttl time.Duration) {
	if !c.Enabled() {
		return
	}
	raw, err := json.Marshal(val)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_ = c.rdb.Set(ctx, key, raw, ttl).Err()
}

// Del removes keys, and is the half of this package that carries correctness.
//
// ── Why a failure here matters more than anywhere else ───────────────────────
// Everything else degrades to "ask the database". A lost DEL degrades to
// SERVING STALE DATA until the TTL expires, which is the one failure mode a
// cache is genuinely responsible for. It is best-effort anyway — there is no
// useful way to make a Redis write from a database transaction atomic — and
// that is precisely why the TTLs above are backstops rather than decoration.
//
// Callers should Del AFTER the database commit, never before: invalidating
// first leaves a window in which a concurrent read repopulates the cache from
// the pre-commit state and then nothing invalidates it again.
func Del(ctx context.Context, c *Cache, keys ...string) {
	if !c.Enabled() || len(keys) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_ = c.rdb.Del(ctx, keys...).Err()
}
