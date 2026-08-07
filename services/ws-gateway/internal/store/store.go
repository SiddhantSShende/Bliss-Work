package store

import (
	"context"
	"crypto/x509"
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

func presenceKey(userID string) string  { return "presence:user:" + userID }
func orgPresenceKey(orgID string) string { return "presence:org:" + orgID }
func outboxKey(userID string) string     { return "outbox:user:" + userID }

// AddPresence records that a connection (nodeId:connId) is live for userID.
func (s *Store) AddPresence(ctx context.Context, userID, nodeID, connID string) error {
	return s.rdb.SAdd(ctx, presenceKey(userID), nodeID+":"+connID).Err()
}

// RemovePresence clears a connection's presence entry.
func (s *Store) RemovePresence(ctx context.Context, userID, nodeID, connID string) error {
	return s.rdb.SRem(ctx, presenceKey(userID), nodeID+":"+connID).Err()
}

// AddOrgPresence marks userID as online within its org (idempotent). It returns
// becameOnline=true only on the transition from absent→present (the user's FIRST
// live connection across all nodes), so the caller can broadcast a single
// presence.online event instead of one per socket/tab.
func (s *Store) AddOrgPresence(ctx context.Context, orgID, userID string) (becameOnline bool, err error) {
	n, err := s.rdb.SAdd(ctx, orgPresenceKey(orgID), userID).Result()
	return n > 0, err
}

// RemoveOrgPresenceIfLast drops userID from the org's online set only when the
// user has no remaining live connections (across all nodes). It returns
// becameOffline=true only on the present→absent transition (the user's LAST
// connection closed), so the caller can broadcast a single presence.offline.
func (s *Store) RemoveOrgPresenceIfLast(ctx context.Context, orgID, userID string) (becameOffline bool, err error) {
	n, err := s.rdb.SCard(ctx, presenceKey(userID)).Result()
	if err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	removed, err := s.rdb.SRem(ctx, orgPresenceKey(orgID), userID).Result()
	return removed > 0, err
}

// OnlineUserIDs returns the user IDs currently connected within an org.
func (s *Store) OnlineUserIDs(ctx context.Context, orgID string) ([]string, error) {
	return s.rdb.SMembers(ctx, orgPresenceKey(orgID)).Result()
}

// PurgePresence deletes every presence:* key. Called ONCE at startup.
//
// Presence entries are keyed nodeId:connId and are removed on graceful socket
// close — but a crash / SIGKILL / container replacement removes nothing, so a
// restarted gateway leaves the previous node's entries orphaned in Redis, and
// those users show "online" forever (this is exactly the stale-presence bug).
//
// A gateway restart drops EVERY socket, so at startup any presence in Redis is
// necessarily from a now-dead node; deleting it all is safe and reconnecting
// clients rebuild it within seconds (they re-add on `hello`, and the 20s client
// poll reconciles). NOTE: assumes a SINGLE gateway node (this deployment). With
// multiple live nodes this would wipe their presence too — replace with a
// node-registry-scoped purge before scaling the gateway horizontally.
func (s *Store) PurgePresence(ctx context.Context) (int, error) {
	var cursor uint64
	total := 0
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, "presence:*", 256).Result()
		if err != nil {
			return total, err
		}
		if len(keys) > 0 {
			if err := s.rdb.Del(ctx, keys...).Err(); err != nil {
				return total, err
			}
			total += len(keys)
		}
		cursor = next
		if cursor == 0 {
			return total, nil
		}
	}
}

// IsOnlineInOrg reports whether userID is currently present in orgID's online
// set. Used to confine RTC signaling to same-org peers: a destination that is
// not in the sender's org online set (cross-org, or offline) is treated as
// unreachable, so the gateway never forwards a frame across an org boundary.
func (s *Store) IsOnlineInOrg(ctx context.Context, orgID, userID string) (bool, error) {
	return s.rdb.SIsMember(ctx, orgPresenceKey(orgID), userID).Result()
}

// AppendOutbox adds a raw event to a user's replay ZSET, scored by occurredAt
// epoch-milliseconds, and refreshes the 7-day TTL.
func (s *Store) AppendOutbox(ctx context.Context, userID string, scoreMs int64, raw []byte) error {
	pipe := s.rdb.TxPipeline()
	pipe.ZAdd(ctx, outboxKey(userID), redis.Z{Score: float64(scoreMs), Member: raw})
	pipe.Expire(ctx, outboxKey(userID), outboxTTL)
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
