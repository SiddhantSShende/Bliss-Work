package store

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/ttlcache"
)

// outboxTTL keeps per-user replay buffers for 7 days.
const outboxTTL = 7 * 24 * time.Hour

// maxReplayDefault is how many recent events are replayed when a client sends
// hello with lastSeenSeq == 0.
const maxReplayDefault = 200

// maxReplayHard caps catch-up replay when a client presents a cursor
// (lastSeenSeq > 0) but is far behind — e.g. it was offline while a busy org
// generated thousands of events. It bounds gateway memory and the per-connect
// stream so a stale cursor can't force an unbounded batch on every reconnect.
// Older events beyond this are backfilled via the REST message/task endpoints.
const maxReplayHard = 2000

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

const (
	// nodeAddrCacheTTL is a third of nodeTTL. Short enough that a graceful
	// DeregisterNode still takes effect promptly, long enough that a call's
	// whole signalling burst — offer, answer and dozens of trickled ICE
	// candidates — resolves the peer's address once instead of per frame.
	nodeAddrCacheTTL = nodeTTL / 3

	// nodeAddrCacheMax bounds the map against pod churn over a long-lived
	// process. A fleet has tens to low hundreds of live nodes; this is room for
	// far more, and every entry is a UUID and a short URL.
	nodeAddrCacheMax = 4096
)

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

// ── Presence ─────────────────────────────────────────────────────────────────
//
// Presence is EXPIRING, and both keys are sorted sets scored by the moment we
// last heard from the connection.
//
// The obvious implementation — SADD on connect, SREM on disconnect — was what
// this used to be, and it is wrong in one specific and very common case. The
// removal lives in a deferred call on the socket's goroutine, so a graceful
// close runs it and a SIGKILL, an OOM kill, a container replacement or a node
// partition runs nothing at all. The dead node's `nodeId:connId` entries then
// sit in Redis forever, the user's connection set never reaches zero, and they
// are reported online indefinitely. The old mitigation was a startup sweep of
// every `presence:*` key, which worked precisely because there was only ever
// one gateway: a second replica starting up would have logged out everybody
// connected to the first.
//
// Scoring by last-heartbeat fixes both. A stale entry ages out on its own, so
// no cleanup path has to survive a crash, and there is nothing global to sweep,
// so N replicas are fine. The heartbeat rides the ping the connection loop
// already sends every 20s — no extra goroutine, no extra timer.
//
// The reads REAP before they answer. That is what makes it self-healing: the
// clients poll /presence every 20s and every socket asks for a snapshot on
// hello, so a crashed node's ghosts are cleared by ordinary traffic within one
// poll rather than by a background job that also has to be kept alive.

const (
	// PresenceHeartbeatInterval is how often a live socket re-stamps its
	// presence entry.
	//
	// This used to ride the websocket ping ticker, which meant one number was
	// doing two unrelated jobs: detecting a dead TCP connection (which wants to
	// be frequent) and keeping a Redis entry fresh (which wants to be as rare
	// as the staleness window allows). Tied together at 20s, presence was the
	// single largest source of Redis traffic in the platform — at 100M sockets
	// that is 5M writes a second before anyone sends a message.
	//
	// Separated, the beat can be sized against presenceStaleAfter alone. 45s
	// inside a 120s window still leaves two full beats of margin — the same
	// tolerance the old 20s/70s pair had — for less than half the writes.
	PresenceHeartbeatInterval = 45 * time.Second

	// presenceStaleAfter is how long an entry may go untouched before it is
	// treated as dead. Two missed heartbeats plus slack. Too tight and a GC
	// pause marks a live user offline; too loose and a crashed node's users
	// linger.
	//
	// MOVES WITH PresenceHeartbeatInterval. The invariant is that this stays
	// comfortably above two beats; changing one without the other either makes
	// live users flicker offline or leaves ghosts around for minutes.
	presenceStaleAfter = 120 * time.Second

	// presenceTTL bounds the keys themselves, so an org that goes quiet leaves
	// nothing behind. Comfortably longer than the stale window: expiring a key
	// that still has live members would drop presence for connected users.
	presenceTTL = 10 * time.Minute
)

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

func (s *Store) presenceKey(userID string) string   { return "presence:u:" + s.tag(userID) }
func (s *Store) orgPresenceKey(orgID string) string { return "presence:o:" + s.tag(orgID) }
func (s *Store) outboxKey(userID string) string     { return "outbox:user:" + s.tag(userID) }

func nowMs() int64 { return time.Now().UnixMilli() }

// staleBefore is the score below which an entry is considered dead.
func staleBefore() float64 { return float64(time.Now().Add(-presenceStaleAfter).UnixMilli()) }

// AddPresence records that a connection (nodeId:connId) is live for userID, and
// stamps it with the current time.
func (s *Store) AddPresence(ctx context.Context, userID, nodeID, connID string) (err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	pipe := s.rdb.TxPipeline()
	pipe.ZAdd(ctx, s.presenceKey(userID), redis.Z{Score: float64(nowMs()), Member: nodeID + ":" + connID})
	pipe.Expire(ctx, s.presenceKey(userID), presenceTTL)
	_, err = pipe.Exec(ctx)
	return err
}

// TouchPresence refreshes the heartbeat for one live connection.
//
// Called from the connection loop's existing ping ticker. Both keys are
// refreshed: the org set's score is what OnlineUserIDs reaps against, so a user
// whose only signal was the connection-level key would age out of the org view
// while still connected.
func (s *Store) TouchPresence(ctx context.Context, orgID, userID, nodeID, connID string) (err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	now := float64(nowMs())
	// Pipeline, NOT TxPipeline. This is the one place that touches two
	// different keys at once, and the user key and the org key hash to
	// different slots — so MULTI/EXEC would fail outright with CROSSSLOT the
	// moment this runs against a cluster.
	//
	// Nothing is lost by dropping the transaction: the two writes are
	// independent heartbeats, and there is no state in which one being applied
	// without the other is incorrect. The cluster client splits a plain
	// pipeline per node and issues the halves in parallel.
	pipe := s.rdb.Pipeline()
	pipe.ZAdd(ctx, s.presenceKey(userID), redis.Z{Score: now, Member: nodeID + ":" + connID})
	pipe.ZAdd(ctx, s.orgPresenceKey(orgID), redis.Z{Score: now, Member: userID})
	// The TTLs are refreshed on a fraction of beats rather than every one.
	// presenceTTL is ten minutes and the beat is measured in tens of seconds,
	// so re-arming it every time is an order of magnitude more writes than the
	// expiry needs — and at a socket per beat, these two commands are the
	// single largest source of Redis traffic in the platform.
	if shouldRefreshTTL() {
		pipe.Expire(ctx, s.presenceKey(userID), presenceTTL)
		pipe.Expire(ctx, s.orgPresenceKey(orgID), presenceTTL)
	}
	_, err = pipe.Exec(ctx)
	return err
}

// ttlRefreshEveryN is how often a heartbeat also re-arms the key TTLs.
//
// Sized from the margin, not picked for roundness. At a 45s beat, 1-in-4 means
// a refresh every 3 minutes against a 10-minute TTL — so a whole refresh cycle
// can be lost to a Redis blip and the key still has 4 minutes left. It cuts
// EXPIRE traffic by 75% and keeps two full cycles inside the expiry window.
//
// 1-in-8 was the first attempt and is WRONG: 6 minutes between refreshes leaves
// only 4 minutes of margin, so one missed cycle expires a live socket's
// presence key underneath it. TestTTLRefreshStaysWellInsideTheExpiryWindow
// asserts the relationship rather than the number, so changing the beat or the
// TTL without redoing this arithmetic fails the build.
const ttlRefreshEveryN = 4

// ttlBeat counts heartbeats process-wide for the sampling above.
var ttlBeat atomic.Uint64

func shouldRefreshTTL() bool {
	// Always refresh on the first beat of a process, so a pod that has just
	// started does not wait up to N beats before arming any TTL at all.
	return ttlBeat.Add(1)%ttlRefreshEveryN == 1
}

// RemovePresence clears a connection's presence entry.
func (s *Store) RemovePresence(ctx context.Context, userID, nodeID, connID string) (err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	return s.rdb.ZRem(ctx, s.presenceKey(userID), nodeID+":"+connID).Err()
}

// AddOrgPresence marks userID as online within its org (idempotent). It returns
// becameOnline=true only on the transition from absent→present (the user's FIRST
// live connection across all nodes), so the caller can broadcast a single
// presence.online event instead of one per socket/tab.
//
// Reaps first: if the user's previous entry is stale (they were on a node that
// died), this IS a fresh transition and the caller should announce it. Without
// the reap, ZAdd would report "already present" and no presence.online would go
// out — the user would be online in Redis and invisible to everyone's UI.
func (s *Store) AddOrgPresence(ctx context.Context, orgID, userID string) (becameOnline bool, err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	key := s.orgPresenceKey(orgID)
	pipe := s.rdb.TxPipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("(%f", staleBefore()))
	added := pipe.ZAdd(ctx, key, redis.Z{Score: float64(nowMs()), Member: userID})
	pipe.Expire(ctx, key, presenceTTL)
	// Assigns the NAMED err rather than declaring a new one in the if-scope:
	// a shadowed error here would leave the deferred metric recording a
	// success for an operation that failed.
	if _, err = pipe.Exec(ctx); err != nil {
		return false, err
	}
	return added.Val() > 0, nil
}

// RemoveOrgPresenceIfLast drops userID from the org's online set only when the
// user has no remaining live connections (across all nodes). It returns
// becameOffline=true only on the present→absent transition (the user's LAST
// connection closed), so the caller can broadcast a single presence.offline.
//
// Evicts stale connection entries before counting. A user whose second tab is
// on a node that crashed must still go offline when they close the first.
func (s *Store) RemoveOrgPresenceIfLast(ctx context.Context, orgID, userID string) (becameOffline bool, err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	// Named err, not a shadowed one — see AddOrgPresence.
	if err = s.rdb.ZRemRangeByScore(ctx, s.presenceKey(userID), "-inf", fmt.Sprintf("(%f", staleBefore())).Err(); err != nil {
		return false, err
	}
	n, err := s.rdb.ZCard(ctx, s.presenceKey(userID)).Result()
	if err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	removed, err := s.rdb.ZRem(ctx, s.orgPresenceKey(orgID), userID).Result()
	return removed > 0, err
}

// OnlineUserIDs returns the user IDs currently connected within an org.
//
// Reap-then-read. This is the self-healing property the whole design rests on:
// /presence is polled every 20s by every client and consulted on every hello,
// so a dead node's ghosts are cleared by traffic that was going to happen
// anyway, with no background job to own or monitor.
func (s *Store) OnlineUserIDs(ctx context.Context, orgID string) (ids []string, err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	key := s.orgPresenceKey(orgID)
	cutoff := staleBefore()
	pipe := s.rdb.TxPipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("(%f", cutoff))
	fresh := pipe.ZRangeByScore(ctx, key, &redis.ZRangeBy{Min: fmt.Sprintf("%f", cutoff), Max: "+inf"})
	// Named err, not a shadowed one — see AddOrgPresence.
	if _, err = pipe.Exec(ctx); err != nil {
		return nil, err
	}
	return fresh.Val(), nil
}

// OnlineAmong answers "which of THESE users are online", without reading an
// org-wide set at all.
//
// ── Why this exists next to OnlineUserIDs ────────────────────────────────────
// `presence:o:<orgId>` is one sorted set per organisation holding every online
// member, reaped on every read, and polled by every client every few seconds.
// That is a single key whose size and read rate both scale with the org, and it
// is the one part of this keyspace that SHARDING CANNOT FIX: a hash tag decides
// which node a key lives on, and one key lives on one node however many nodes
// there are. A large org is a hot slot by construction.
//
// The way out is not a better key, it is a better question. A client does not
// need to know who in a 200,000-person organisation is online; it needs to know
// about the forty people currently on screen. That question reads per-user keys
// — which shard perfectly, because they are already tagged by user id — and its
// cost scales with what is being displayed rather than with the size of the
// company.
//
// OnlineUserIDs is left in place: the endpoint it serves is still in use, and
// removing it before clients have moved would break them. This is the
// replacement they should move to.
func (s *Store) OnlineAmong(ctx context.Context, userIDs []string) (online []string, err error) {
	online = []string{}
	if len(userIDs) == 0 {
		return online, nil
	}
	defer observe(metrics.PurposePresence, time.Now(), &err)

	cutoff := fmt.Sprintf("%f", staleBefore())
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.StringSliceCmd, len(userIDs))
	for i, uid := range userIDs {
		// A ZRANGEBYSCORE bounded to one entry: the question is "is there any
		// live connection", not "how many", so there is no reason to transfer
		// every socket a user has open across all their devices.
		cmds[i] = pipe.ZRangeByScore(ctx, s.presenceKey(uid), &redis.ZRangeBy{
			Min:   cutoff,
			Max:   "+inf",
			Count: 1,
		})
	}
	// redis.Nil means at least one user had no key, which for a partly-offline
	// list is the normal case rather than a failure.
	//
	// Assigns the NAMED err rather than declaring a new one with `:=` — see
	// AddOrgPresence. A shadowed error here leaves the deferred observe()
	// recording a SUCCESS for an operation that failed, so
	// ws_redis_ops_total{result="error"} under-reports exactly the presence
	// failures worth paging on. Cleared afterwards so a redis.Nil, which is the
	// ordinary partly-offline case, is not itself counted as an error.
	if _, err = pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	err = nil
	for i, cmd := range cmds {
		if members, cerr := cmd.Result(); cerr == nil && len(members) > 0 {
			online = append(online, userIDs[i])
		}
	}
	return online, nil
}

// IsOnlineInOrg reports whether userID is currently present in orgID's online
// set. Used to confine RTC signaling to same-org peers: a destination that is
// not in the sender's org online set (cross-org, or offline) is treated as
// unreachable, so the gateway never forwards a frame across an org boundary.
//
// Checks freshness rather than mere membership — routing a call frame to a
// peer whose node died is exactly the case this must refuse.
func (s *Store) IsOnlineInOrg(ctx context.Context, orgID, userID string) (online bool, err error) {
	defer observe(metrics.PurposePresence, time.Now(), &err)
	score, err := s.rdb.ZScore(ctx, s.orgPresenceKey(orgID), userID).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return score >= staleBefore(), nil
}

// AppendOutbox adds a raw event to a user's replay ZSET, scored by occurredAt
// epoch-milliseconds, trims the key to the deepest replay any client can ask
// for, and refreshes the 7-day TTL.
//
// The trim is not an optimisation, it is the only thing bounding this key.
// Expire below is refreshed on every append, which makes the TTL seven days of
// INACTIVITY rather than a rolling seven-day window — so an active user's key
// was previously bounded by nothing at all, and one message into an N-member
// channel is stored N times, once per recipient. Redis is also the source of
// truth for replay, so it is the thing that dies first when this grows.
//
// Cutting at maxReplayHard is lossless with respect to observable behaviour:
// Replay never returns more than maxReplayHard entries (see Replay), so
// anything below the cut is data no client could ever receive.
func (s *Store) AppendOutbox(ctx context.Context, userID string, scoreMs int64, raw []byte) (err error) {
	defer observe(metrics.PurposeOutbox, time.Now(), &err)
	key := s.outboxKey(userID)
	pipe := s.rdb.TxPipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(scoreMs), Member: raw})
	pipe.ZRemRangeByRank(ctx, key, 0, -(maxReplayHard + 1))
	pipe.Expire(ctx, key, outboxTTL)
	_, err = pipe.Exec(ctx)
	return err
}

// ── Node registry ────────────────────────────────────────────────────────────
//
// Where routed delivery gets its routing table.
//
// Half of it already existed: `presence:u:<userId>` is a ZSET whose members are
// `nodeId:connId`, so "which nodes hold this user's sockets" is a read of a key
// the gateway has been maintaining all along. The missing half is turning a
// nodeId into somewhere to send a request, which is what these add.
//
// TTL-based, like presence and for the same reason: a pod that is SIGKILLed,
// OOM-killed or evicted runs no cleanup, so anything that depends on a
// deregistration step is wrong the first time a node dies badly. An entry that
// ages out on its own needs no such step. The registration is refreshed on a
// ticker; miss enough refreshes and the node stops being routable, which is
// exactly the desired behaviour for a node that has stopped.

const (
	// nodeTTL bounds how long a dead node stays routable. Pushes to it fail
	// during that window, which is harmless — the event is already in the
	// user's replay outbox and the client re-reads it on reconnect — but a
	// shorter window means fewer wasted requests.
	nodeTTL = 30 * time.Second

	// NodeHeartbeatInterval is how often a live node should re-register. Three
	// beats inside nodeTTL, so a single missed tick (a GC pause, a slow Redis)
	// does not deregister a healthy node.
	NodeHeartbeatInterval = 10 * time.Second
)

// Tagged like the rest, so that in cluster mode a node's address sits on a
// predictable slot rather than wherever the whole key happened to hash.
func (s *Store) nodeKey(nodeID string) string { return "node:" + s.tag(nodeID) }

// RegisterNode advertises this gateway as reachable at addr.
//
// Call on boot and then every NodeHeartbeatInterval. addr is a base URL the
// delivery service can actually reach — a pod IP in Kubernetes, a service name
// in compose — and NOT anything derived from the request, since the node is
// describing itself.
func (s *Store) RegisterNode(ctx context.Context, nodeID, addr string) (err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	return s.rdb.Set(ctx, s.nodeKey(nodeID), addr, nodeTTL).Err()
}

// DeregisterNode removes this node immediately.
//
// An optimisation on graceful shutdown, never a correctness requirement: the
// TTL is what actually guarantees removal, and this only shortens the window in
// which pushes are sent to a pod that has already drained its sockets.
func (s *Store) DeregisterNode(ctx context.Context, nodeID string) (err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	return s.rdb.Del(ctx, s.nodeKey(nodeID)).Err()
}

// NodesForUser returns the ids of nodes currently holding a socket for userID.
//
// Reads the same heartbeat-scored ZSET presence uses, and applies the same
// staleness cutoff, so a node that died does not attract pushes for the users
// it used to hold. Returns each node once even when a user has several sockets
// on it — the push carries a user id, and that node fans out to all of them.
func (s *Store) NodesForUser(ctx context.Context, userID string) (nodes []string, err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	members, err := s.rdb.ZRangeByScore(ctx, s.presenceKey(userID), &redis.ZRangeBy{
		Min: fmt.Sprintf("%f", staleBefore()),
		Max: "+inf",
	}).Result()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(members))
	for _, m := range members {
		// Members are "nodeId:connId"; a connId cannot contain a colon (both
		// halves are UUIDs), so the first colon is the separator.
		nodeID, _, ok := strings.Cut(m, ":")
		if !ok || nodeID == "" {
			continue
		}
		if _, dup := seen[nodeID]; dup {
			continue
		}
		seen[nodeID] = struct{}{}
		nodes = append(nodes, nodeID)
	}
	return nodes, nil
}

// NodesForUsers is NodesForUser for a whole recipient list, in one round trip.
//
// The batch form is not an optimisation, it is what makes routed delivery worth
// doing. One message into a thousand-member channel is a thousand recipients;
// asking Redis about each of them separately would replace the broadcast's
// wasted CPU with a thousand sequential round trips, which is a worse trade.
// Pipelining sends them together and reads the replies together.
//
// Users with no live socket are absent from the result rather than mapping to
// an empty slice — "nobody to route to" and "not in the map" are the same fact
// and the caller treats them the same way.
func (s *Store) NodesForUsers(ctx context.Context, userIDs []string) (out map[string][]string, err error) {
	out = make(map[string][]string, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	defer observe(metrics.PurposeNodes, time.Now(), &err)

	cutoff := fmt.Sprintf("%f", staleBefore())
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.StringSliceCmd, len(userIDs))
	for i, uid := range userIDs {
		cmds[i] = pipe.ZRangeByScore(ctx, s.presenceKey(uid), &redis.ZRangeBy{
			Min: cutoff,
			Max: "+inf",
		})
	}
	// redis.Nil is returned when SOME command in the pipeline found nothing,
	// which for a fan-out to a partly-offline audience is the normal case
	// rather than a failure. Any other error is real.
	//
	// Assigns the NAMED err, not a shadowed one — see AddOrgPresence and
	// OnlineAmong. This is the routing lookup on the delivery hot path, so a
	// failure recorded as a success is the one most worth not making: it is the
	// signal that says "events are not being routed". Cleared afterwards so the
	// ordinary redis.Nil is not counted as an error.
	if _, err = pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	err = nil

	for i, cmd := range cmds {
		members, cerr := cmd.Result()
		if cerr != nil {
			continue // this user has no live socket; the rest are still valid
		}
		seen := make(map[string]struct{}, len(members))
		var nodes []string
		for _, m := range members {
			nodeID, _, ok := strings.Cut(m, ":")
			if !ok || nodeID == "" {
				continue
			}
			if _, dup := seen[nodeID]; dup {
				continue
			}
			seen[nodeID] = struct{}{}
			nodes = append(nodes, nodeID)
		}
		if len(nodes) > 0 {
			out[userIDs[i]] = nodes
		}
	}
	return out, nil
}

// AppendOutboxMulti writes one event to many users' replay buffers at once.
//
// Same reasoning as NodesForUsers: this is three Redis commands per recipient,
// and issuing them a recipient at a time would make a large fan-out a long
// sequence of round trips. Pipelined, it is one.
//
// Not a transaction. TxPipeline would wrap all of it in MULTI/EXEC, which buys
// atomicity nobody needs here — these are independent per-user keys, and a
// partial write is recovered by the same at-least-once retry that covers a
// total failure.
func (s *Store) AppendOutboxMulti(
	ctx context.Context, userIDs []string, scoreMs int64, raw []byte,
) (err error) {
	if len(userIDs) == 0 {
		return nil
	}
	defer observe(metrics.PurposeOutbox, time.Now(), &err)
	pipe := s.rdb.Pipeline()
	for _, uid := range userIDs {
		key := s.outboxKey(uid)
		pipe.ZAdd(ctx, key, redis.Z{Score: float64(scoreMs), Member: raw})
		pipe.ZRemRangeByRank(ctx, key, 0, -(maxReplayHard + 1))
		pipe.Expire(ctx, key, outboxTTL)
	}
	_, err = pipe.Exec(ctx)
	return err
}

// NodeAddrs resolves node ids to base URLs, reading Redis only for ids it has
// not seen recently.
//
// Nodes whose registration has expired are simply absent from the result rather
// than being an error: a node disappearing between the presence read and this
// lookup is ordinary, and the caller's response — skip it, the outbox has the
// event — is the same either way.
//
// ── Why caching this is not a staleness trade ────────────────────────────────
// A node id is a fresh UUID minted at process start, and RegisterNode only ever
// writes the same address under it. So the mapping is IMMUTABLE for the life of
// the node: a cached answer cannot be wrong in the way a cached presence lookup
// can, because there is no second value it could have become.
//
// The only thing the cache can miss is a node that has DIED — and the answer to
// that was already stale before, by up to nodeTTL, since a dead pod's key
// lingers until it expires. Caching for a fraction of nodeTTL keeps that window
// the same order of magnitude while removing a Redis round trip from every
// cross-node delivery. DeregisterNode on graceful shutdown becomes slightly less
// prompt, which it can afford: it was already documented as an optimisation on
// top of the TTL rather than a correctness requirement.
//
// Misses are NOT cached. An unregistered node is very often one that is about to
// register — a pod still booting — and remembering its absence would keep it
// unroutable for longer than the truth warrants.
func (s *Store) NodeAddrs(ctx context.Context, nodeIDs []string) (map[string]string, error) {
	if len(nodeIDs) == 0 {
		return map[string]string{}, nil
	}

	addrs := make(map[string]string, len(nodeIDs))
	var missing []string
	for _, id := range nodeIDs {
		if addr, ok := s.addrCache.Get(id); ok {
			addrs[id] = addr
			metrics.RouteCacheTotal.WithLabelValues(metrics.CacheNodeAddr, metrics.CacheHit).Inc()
			continue
		}
		metrics.RouteCacheTotal.WithLabelValues(metrics.CacheNodeAddr, metrics.CacheMiss).Inc()
		missing = append(missing, id)
	}
	if len(missing) == 0 {
		return addrs, nil
	}

	fetched, err := s.fetchNodeAddrs(ctx, missing)
	if err != nil {
		return nil, err
	}
	for id, addr := range fetched {
		s.addrCache.Put(id, addr)
		addrs[id] = addr
	}
	return addrs, nil
}

// ForgetNodeAddr drops a cached address. Called when a push to it failed, so the
// next delivery re-reads rather than retrying an address that may belong to a
// pod that has gone.
func (s *Store) ForgetNodeAddr(nodeID string) { s.addrCache.Forget(nodeID) }

func (s *Store) fetchNodeAddrs(ctx context.Context, nodeIDs []string) (addrs map[string]string, err error) {
	defer observe(metrics.PurposeNodes, time.Now(), &err)
	// Pipelined GETs, not MGET. MGET requires every key to live in the same
	// slot, and node ids hash all over the keyspace — so under a cluster the
	// single-command form fails with CROSSSLOT exactly when the fleet is large
	// enough for this to matter. A pipeline is split per node by the cluster
	// client and costs the same one round trip per node it has to talk to.
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.StringCmd, len(nodeIDs))
	for i, id := range nodeIDs {
		cmds[i] = pipe.Get(ctx, s.nodeKey(id))
	}
	// redis.Nil here means at least one node's registration has expired, which
	// is ordinary — a pod restarting is exactly this. Any other error is real.
	if _, err = pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	err = nil
	addrs = make(map[string]string, len(nodeIDs))
	for i, cmd := range cmds {
		addr, cerr := cmd.Result()
		if cerr != nil || addr == "" {
			continue // expired between the presence read and here
		}
		addrs[nodeIDs[i]] = addr
	}
	return addrs, nil
}

// NOTE: the Redis pub/sub paths that used to live here are gone.
//
// RTC signalling used `PUBLISH rtc:user:<id>` against a channel every gateway
// matched with `PSUBSCRIBE rtc:user:*`, and presence used a single shared
// `presence:events` channel. Both were BROADCASTS: every node received every
// frame in the platform and discarded what it could not deliver, so cost scaled
// with node count rather than with traffic.
//
// Neither would have survived sharding either. Classic Redis pub/sub is
// delivered to every node of a cluster regardless of what the channel name
// hashes to, so moving Redis to a cluster would have divided none of that work.
//
// Both now route through the node registry above — NodesForUsers to find where
// a recipient's sockets are, NodeAddrs to reach those nodes, and a direct push.
// See internal/push/fanout.go.

// Replay returns events for catch-up, oldest-first. When lastSeenSeq <= 0 it
// returns the most recent maxReplayDefault entries. Otherwise it returns entries
// scored at or after lastSeenSeq, capped at the most recent maxReplayHard so a
// very old cursor can't force an unbounded batch onto every reconnect (older
// history is reachable via the REST message/task endpoints).
//
// ── Why the lower bound is INCLUSIVE, and why that is not an off-by-one ──────
//
// The score is `occurredAt` truncated to MILLISECONDS (see fanout.epochMs and
// router.epochMs), and the client's cursor is `Date.parse(occurredAt)` — also
// milliseconds, because that is the only precision a JS Date carries. So the
// cursor cannot distinguish two events that share a millisecond, and a busy
// user has those constantly: a channel message and its notification, two sends
// into the same room, a reaction landing beside a read receipt.
//
// With an exclusive bound (`(lastSeenSeq`) that ambiguity was silent data loss.
// A client that received event A at time T advanced its high-water mark to T;
// if the socket dropped before event B — also at T — arrived, the reconnect
// asked for "strictly after T" and B was excluded. Permanently: the outbox is
// the only catch-up path, nothing retries, and the client's dedup LRU is
// per-instance so nothing downstream noticed. The user simply never received a
// message, with no error anywhere.
//
// Inclusive turns that into a duplicate instead, and a duplicate costs nothing
// here: every client dedupes on `eventId` (WsClient.handleMessage), which is
// the same mechanism that already makes the at-least-once Kafka path safe. The
// re-sent set is also tiny — only the entries sharing the boundary millisecond,
// typically one — so this is a few hundred bytes per reconnect to close a
// message-loss hole.
//
// The alternative, a monotonic per-user sequence, is the better long-term shape
// but changes the score, the client cursor and the wire contract together. This
// is the correction that can ship without a flag day, and it fails in the
// direction that the client already handles.
func (s *Store) Replay(ctx context.Context, userID string, lastSeenSeq int64) (out [][]byte, err error) {
	defer observe(metrics.PurposeOutbox, time.Now(), &err)
	key := s.outboxKey(userID)
	var raws []string
	if lastSeenSeq <= 0 {
		// Most recent N, then ordered oldest-first.
		raws, err = s.rdb.ZRange(ctx, key, -maxReplayDefault, -1).Result()
	} else {
		min := fmt.Sprintf("%d", lastSeenSeq) // INCLUSIVE — see above
		// Most recent maxReplayHard from the cursor (highest-first), then
		// reversed below to oldest-first for in-order client replay.
		raws, err = s.rdb.ZRevRangeByScore(ctx, key, &redis.ZRangeBy{
			Min:   min,
			Max:   "+inf",
			Count: maxReplayHard,
		}).Result()
		if err == nil {
			for i, j := 0, len(raws)-1; i < j; i, j = i+1, j-1 {
				raws[i], raws[j] = raws[j], raws[i]
			}
		}
	}
	if err != nil {
		return nil, err
	}
	out = make([][]byte, 0, len(raws))
	for _, r := range raws {
		out = append(out, []byte(r))
	}
	return out, nil
}
