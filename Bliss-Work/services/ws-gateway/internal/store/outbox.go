package store

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/task-board/ws-gateway/internal/metrics"
)

// outboxTTL keeps per-user replay buffers for 1 day.
//
// Was 7 days. Real sampling of prod outbox entries (~605 bytes/entry) against
// prod Redis's actual 2GB maxmemory/noeviction config puts the fill point at
// roughly 3,245-4,868 DAU — tighter than the HTTP tier's measured ceiling by
// about 5x. A short-lived client can still miss more than a day of backlog and
// fall back to the REST catch-up path; a live client reconnecting after a
// normal restart is unaffected (see maxReplayHard below).
const outboxTTL = 24 * time.Hour

// maxReplayDefault is how many recent events are replayed when a client sends
// hello with lastSeenSeq == 0.
const maxReplayDefault = 200

// maxReplayHard caps catch-up replay when a client presents a cursor
// (lastSeenSeq > 0) but is far behind — e.g. it was offline while a busy org
// generated thousands of events. It bounds gateway memory and the per-connect
// stream so a stale cursor can't force an unbounded batch on every reconnect.
// Older events beyond this are backfilled via the REST message/task endpoints.
//
// Was 2000. Lowered per docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md's Phase D/M
// analysis: the cursor-based path this constant governs is only reachable by
// a socket reconnecting within an already-running client process (a fresh
// app launch always resets to the separate, unaffected cursorless
// maxReplayDefault path — see WsClient.ts's highWaterMs), which narrows who
// is actually exposed to the lower cap. At 40K users this keeps outbox
// memory at ~51% of the 2 GiB ceiling (vs. >100% at the old cap), with real
// headroom toward the platform's actual 1B-DAU target.
const maxReplayHard = 100

func (s *Store) outboxKey(userID string) string { return "outbox:user:" + s.tag(userID) }

// AppendOutbox adds a raw event to a user's replay ZSET, scored by occurredAt
// epoch-milliseconds, trims the key to the deepest replay any client can ask
// for, and refreshes the outboxTTL (see its own doc for why it's 1 day, not
// the 7 it started as).
//
// The trim is not an optimisation, it is the only thing bounding this key.
// Expire below is refreshed on every append, which makes the TTL a window of
// INACTIVITY rather than a rolling one — so an active user's key
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

// Replay returns events for catch-up, oldest-first. When lastSeenSeq <= 0 it
// returns the most recent maxReplayDefault entries. Otherwise it returns entries
// scored at or after lastSeenSeq, capped at the most recent maxReplayHard so a
// very old cursor can't force an unbounded batch onto every reconnect (older
// history is reachable via the REST message/task endpoints).
//
// ── Why the lower bound is INCLUSIVE, and why that is not an off-by-one ──────
//
// The score is `occurredAt` truncated to MILLISECONDS (see contract.EpochMs),
// and the client's cursor is `Date.parse(occurredAt)` — also milliseconds,
// because that is the only precision a JS Date carries. So the cursor cannot
// distinguish two events that share a millisecond, and a busy user has those
// constantly: a channel message and its notification, two sends into the
// same room, a reaction landing beside a read receipt.
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
