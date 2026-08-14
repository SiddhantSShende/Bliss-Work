package store

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
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
type Store struct {
	rdb *redis.Client
}

// New parses a redis:// or rediss:// URL and returns a Store.
//
// rediss:// (TLS) validates against the SYSTEM roots by default, so a private /
// self-signed Redis CA won't verify. If REDIS_CA_CERT (a PEM path) is set, it is
// loaded into the client's RootCAs so a private CA works (use managed Redis with
// a publicly-trusted cert to avoid this). REDIS_TLS_SKIP_VERIFY=1 disables
// verification — TESTING ONLY; never in prod.
func New(redisURL string) (*Store, error) {
	opt, err := redis.ParseURL(redisURL)
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
	return &Store{rdb: redis.NewClient(opt)}, nil
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
	// presenceStaleAfter is how long an entry may go untouched before it is
	// treated as dead. Three missed 20s heartbeats plus slack — the same
	// three-missed-beats reasoning telemetry-svc uses for its session timeout.
	// Too tight and a GC pause marks a live user offline; too loose and a
	// crashed node's users linger.
	presenceStaleAfter = 70 * time.Second

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
func presenceKey(userID string) string   { return "presence:u:" + userID }
func orgPresenceKey(orgID string) string { return "presence:o:" + orgID }
func outboxKey(userID string) string     { return "outbox:user:" + userID }

func nowMs() int64 { return time.Now().UnixMilli() }

// staleBefore is the score below which an entry is considered dead.
func staleBefore() float64 { return float64(time.Now().Add(-presenceStaleAfter).UnixMilli()) }

// AddPresence records that a connection (nodeId:connId) is live for userID, and
// stamps it with the current time.
func (s *Store) AddPresence(ctx context.Context, userID, nodeID, connID string) error {
	pipe := s.rdb.TxPipeline()
	pipe.ZAdd(ctx, presenceKey(userID), redis.Z{Score: float64(nowMs()), Member: nodeID + ":" + connID})
	pipe.Expire(ctx, presenceKey(userID), presenceTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// TouchPresence refreshes the heartbeat for one live connection.
//
// Called from the connection loop's existing ping ticker. Both keys are
// refreshed: the org set's score is what OnlineUserIDs reaps against, so a user
// whose only signal was the connection-level key would age out of the org view
// while still connected.
func (s *Store) TouchPresence(ctx context.Context, orgID, userID, nodeID, connID string) error {
	now := float64(nowMs())
	pipe := s.rdb.TxPipeline()
	pipe.ZAdd(ctx, presenceKey(userID), redis.Z{Score: now, Member: nodeID + ":" + connID})
	pipe.Expire(ctx, presenceKey(userID), presenceTTL)
	pipe.ZAdd(ctx, orgPresenceKey(orgID), redis.Z{Score: now, Member: userID})
	pipe.Expire(ctx, orgPresenceKey(orgID), presenceTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// RemovePresence clears a connection's presence entry.
func (s *Store) RemovePresence(ctx context.Context, userID, nodeID, connID string) error {
	return s.rdb.ZRem(ctx, presenceKey(userID), nodeID+":"+connID).Err()
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
	key := orgPresenceKey(orgID)
	pipe := s.rdb.TxPipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("(%f", staleBefore()))
	added := pipe.ZAdd(ctx, key, redis.Z{Score: float64(nowMs()), Member: userID})
	pipe.Expire(ctx, key, presenceTTL)
	if _, err := pipe.Exec(ctx); err != nil {
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
	if err := s.rdb.ZRemRangeByScore(ctx, presenceKey(userID), "-inf", fmt.Sprintf("(%f", staleBefore())).Err(); err != nil {
		return false, err
	}
	n, err := s.rdb.ZCard(ctx, presenceKey(userID)).Result()
	if err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	removed, err := s.rdb.ZRem(ctx, orgPresenceKey(orgID), userID).Result()
	return removed > 0, err
}

// OnlineUserIDs returns the user IDs currently connected within an org.
//
// Reap-then-read. This is the self-healing property the whole design rests on:
// /presence is polled every 20s by every client and consulted on every hello,
// so a dead node's ghosts are cleared by traffic that was going to happen
// anyway, with no background job to own or monitor.
func (s *Store) OnlineUserIDs(ctx context.Context, orgID string) ([]string, error) {
	key := orgPresenceKey(orgID)
	cutoff := staleBefore()
	pipe := s.rdb.TxPipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("(%f", cutoff))
	fresh := pipe.ZRangeByScore(ctx, key, &redis.ZRangeBy{Min: fmt.Sprintf("%f", cutoff), Max: "+inf"})
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	return fresh.Val(), nil
}

// IsOnlineInOrg reports whether userID is currently present in orgID's online
// set. Used to confine RTC signaling to same-org peers: a destination that is
// not in the sender's org online set (cross-org, or offline) is treated as
// unreachable, so the gateway never forwards a frame across an org boundary.
//
// Checks freshness rather than mere membership — routing a call frame to a
// peer whose node died is exactly the case this must refuse.
func (s *Store) IsOnlineInOrg(ctx context.Context, orgID, userID string) (bool, error) {
	score, err := s.rdb.ZScore(ctx, orgPresenceKey(orgID), userID).Result()
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
func (s *Store) AppendOutbox(ctx context.Context, userID string, scoreMs int64, raw []byte) error {
	key := outboxKey(userID)
	pipe := s.rdb.TxPipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(scoreMs), Member: raw})
	pipe.ZRemRangeByRank(ctx, key, 0, -(maxReplayHard + 1))
	pipe.Expire(ctx, key, outboxTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// RtcChannel returns the Redis pub/sub channel name used to deliver an RTC
// signaling frame to userID when the recipient is connected to a different
// gateway node. Channel-name format intentionally simple so operators can
// PSUBSCRIBE 'rtc:user:*' for debugging.
func RtcChannel(userID string) string { return "rtc:user:" + userID }

// PublishRTC ships a raw signaling frame to userID via Redis pub/sub. Best-
// effort: pub/sub is at-most-once, but the design has accepted that — a
// dropped ICE candidate is a transient failure the caller retries.
func (s *Store) PublishRTC(ctx context.Context, userID string, raw []byte) error {
	return s.rdb.Publish(ctx, RtcChannel(userID), raw).Err()
}

// SubscribeRTC opens a Redis PSUBSCRIBE on rtc:user:* and delivers every
// payload back into onMessage(userID, raw). Returns when ctx is done.
func (s *Store) SubscribeRTC(ctx context.Context, onMessage func(userID string, raw []byte)) {
	sub := s.rdb.PSubscribe(ctx, "rtc:user:*")
	defer func() { _ = sub.Close() }()
	ch := sub.Channel()
	const prefix = "rtc:user:"
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			if len(m.Channel) <= len(prefix) {
				continue
			}
			onMessage(m.Channel[len(prefix):], []byte(m.Payload))
		}
	}
}

// presenceChannel is the single Redis pub/sub channel carrying presence
// online/offline transitions. Presence is EPHEMERAL — like RTC frames it is
// never written to the per-user replay outbox (a reconnecting client gets a
// fresh presence.snapshot on hello instead, so it can never replay stale
// online/offline state).
const presenceChannel = "presence:events"

// PublishPresence ships a raw presence event to every gateway node. Best-effort
// (at-most-once) — a missed transition is reconciled by the 20s presence poll
// and the next snapshot.
func (s *Store) PublishPresence(ctx context.Context, raw []byte) error {
	return s.rdb.Publish(ctx, presenceChannel, raw).Err()
}

// SubscribePresence opens a Redis SUBSCRIBE on the presence channel and delivers
// every raw payload into onMessage. Returns when ctx is done.
func (s *Store) SubscribePresence(ctx context.Context, onMessage func(raw []byte)) {
	sub := s.rdb.Subscribe(ctx, presenceChannel)
	defer func() { _ = sub.Close() }()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			onMessage([]byte(m.Payload))
		}
	}
}

// Replay returns events for catch-up, oldest-first. When lastSeenSeq <= 0 it
// returns the most recent maxReplayDefault entries. Otherwise it returns entries
// with score strictly greater than lastSeenSeq, capped at the most recent
// maxReplayHard so a very old cursor can't force an unbounded batch onto every
// reconnect (older history is reachable via the REST message/task endpoints).
func (s *Store) Replay(ctx context.Context, userID string, lastSeenSeq int64) ([][]byte, error) {
	key := outboxKey(userID)
	var raws []string
	var err error
	if lastSeenSeq <= 0 {
		// Most recent N, then ordered oldest-first.
		raws, err = s.rdb.ZRange(ctx, key, -maxReplayDefault, -1).Result()
	} else {
		min := fmt.Sprintf("(%d", lastSeenSeq) // exclusive lower bound
		// Most recent maxReplayHard after the cursor (highest-first), then
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
	out := make([][]byte, 0, len(raws))
	for _, r := range raws {
		out = append(out, []byte(r))
	}
	return out, nil
}
