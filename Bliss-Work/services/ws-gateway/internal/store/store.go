package store

import (
	"context"
	"crypto/x509"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/ttlcache"
)

// Store wraps Redis for presence tracking and per-user replay outboxes.
//
// The client is a UniversalClient so one Store serves both a single node and a
// cluster. `clustered` is not cosmetic — it changes how keys are NAMED (see the
// key builders below), so it is recorded rather than inferred at each use.
type Store struct {
	rdb       redis.UniversalClient
	clustered bool

	// addrCache holds node id → address. See NodeAddrs for why this one is safe
	// to cache and the presence reads around it are not.
	addrCache *ttlcache.Cache[string]
}

// New builds a Store from a redis:// or rediss:// URL, or from several.
//
// ── Single node vs cluster ───────────────────────────────────────────────────
// One URL gives the client this service has always used. SEVERAL, comma
// separated, give a cluster client instead — that is the whole switch, because
// go-redis's UniversalClient covers both and every call site below is written
// against the interface.
//
// The distinction is remembered because cluster mode also changes the keyspace:
// keys are hash-tagged so a user's data lands on one slot. Single-node
// deployments therefore keep their existing key names and lose nothing on
// upgrade; see the key builders.
//
// rediss:// (TLS) validates against the SYSTEM roots by default, so a private /
// self-signed Redis CA won't verify. If REDIS_CA_CERT (a PEM path) is set, it is
// loaded into the client's RootCAs so a private CA works (use managed Redis with
// a publicly-trusted cert to avoid this). REDIS_TLS_SKIP_VERIFY=1 disables
// verification — TESTING ONLY; never in prod.
func New(redisURL string) (*Store, error) {
	urls := splitURLs(redisURL)
	if len(urls) == 0 {
		return nil, fmt.Errorf("redis url is empty")
	}

	// Every URL is parsed, but only the first supplies the shared settings
	// (credentials, database, TLS). A cluster speaks one auth and one TLS
	// config across its nodes; differing ones would be a configuration
	// mistake, and taking the first is what makes the addresses the only thing
	// that varies.
	opt, err := redis.ParseURL(urls[0])
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	if opt.TLSConfig != nil { // set by ParseURL only for rediss://
		if caPath := os.Getenv("REDIS_CA_CERT"); caPath != "" {
			// caPath is REDIS_CA_CERT, set by whoever deploys this process.
			// It is not reachable from any request, so there is no untrusted
			// input to traverse with.
			pem, readErr := os.ReadFile(caPath) //nolint:gosec // G703: operator-supplied path
			if readErr != nil {
				return nil, fmt.Errorf("read REDIS_CA_CERT: %w", readErr)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, fmt.Errorf("REDIS_CA_CERT %s: no certificates parsed", caPath)
			}
			opt.TLSConfig.RootCAs = pool
		}
		if os.Getenv("REDIS_TLS_SKIP_VERIFY") == "1" {
			opt.TLSConfig.InsecureSkipVerify = true // #nosec G402 — testing only
		}
	}

	if len(urls) == 1 {
		return &Store{
			rdb:       redis.NewClient(opt),
			addrCache: ttlcache.New[string](nodeAddrCacheTTL, nodeAddrCacheMax),
		}, nil
	}

	addrs := make([]string, 0, len(urls))
	for _, u := range urls {
		o, perr := redis.ParseURL(u)
		if perr != nil {
			return nil, fmt.Errorf("parse redis url %q: %w", u, perr)
		}
		addrs = append(addrs, o.Addr)
	}
	return &Store{
		clustered: true,
		rdb: redis.NewClusterClient(&redis.ClusterOptions{
			Addrs:     addrs,
			Username:  opt.Username,
			Password:  opt.Password,
			TLSConfig: opt.TLSConfig,
		}),
		addrCache: ttlcache.New[string](nodeAddrCacheTTL, nodeAddrCacheMax),
	}, nil
}

// splitURLs accepts one URL or a comma-separated list.
func splitURLs(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Clustered reports whether this Store is talking to a Redis Cluster. Exposed
// so a process can say so in its startup log — the keyspace differs between the
// two, and finding that out from a missing key is a bad way to learn it.
func (s *Store) Clustered() bool { return s.clustered }

// observe records one Redis round trip against its purpose.
//
// Deferred at the top of each method rather than wrapped around the client,
// because the useful split is not "which Redis command" but "what was it FOR" —
// presence heartbeats, replay outboxes and pub/sub share one server and have
// completely different shapes, and sizing or sharding the tier means knowing
// which of the three is the load. A go-redis hook could count commands but
// could not tell them apart.
//
// Usage: `defer observe(metrics.PurposePresence, time.Now(), &err)`. The error
// is taken by POINTER so the deferred call sees the value the function actually
// returns rather than whatever it was at defer time.
func observe(purpose string, start time.Time, err *error) {
	metrics.RedisOpDuration.WithLabelValues(purpose).Observe(time.Since(start).Seconds())
	var e error
	if err != nil {
		e = *err
	}
	metrics.RedisOpsTotal.WithLabelValues(purpose, metrics.Result(e)).Inc()
}

// Ping verifies connectivity.
func (s *Store) Ping(ctx context.Context) error {
	return s.rdb.Ping(ctx).Err()
}

// Close releases the underlying client.
func (s *Store) Close() error { return s.rdb.Close() }

// Key prefixes are deliberately NOT the old `presence:user:` / `presence:org:`.
//
// These keys change type from SET to ZSET, and SADD against an existing ZSET
// fails with WRONGTYPE. Renaming means that during a rolling deploy the old and
// new pods write disjoint keyspaces and neither errors; the old keys are simply
// abandoned and expire from irrelevance. The cost is one rollout during which
// presence is split across two views, which is acceptable — presence is
// ephemeral by design and every client gets an authoritative snapshot on its
// next hello.
// ── Hash tags ────────────────────────────────────────────────────────────────
//
// Redis Cluster assigns a key to one of 16384 slots by hashing the whole key —
// UNLESS the key contains a {...} section, in which case only that section is
// hashed. Tagging by user id is what puts a user's presence entry and their
// replay outbox on the same node, so the two reads a delivery needs do not
// become two network hops to two different machines.
//
// The tag is applied ONLY in cluster mode, and that is the careful part.
// Braces are ordinary characters to a single node, so tagging unconditionally
// would be harmless in behaviour and expensive in practice: it renames every
// key, and while presence is ephemeral (a rename costs one poll), the replay
// outbox holds seven days of catch-up history. Renaming it would silently drop
// that for every user on the deploy that shipped the change.
//
// Turning on clustering means standing up a new Redis anyway, so there is no
// keyspace to migrate at the moment the names change — which is exactly why
// this is the cheap moment to change them, and any other moment is not.
func (s *Store) tag(id string) string {
	if s.clustered {
		return "{" + id + "}"
	}
	return id
}
