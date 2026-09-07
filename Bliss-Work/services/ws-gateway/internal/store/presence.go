package store

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/task-board/ws-gateway/internal/metrics"
)

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

func (s *Store) presenceKey(userID string) string   { return "presence:u:" + s.tag(userID) }
func (s *Store) orgPresenceKey(orgID string) string { return "presence:o:" + s.tag(orgID) }

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
