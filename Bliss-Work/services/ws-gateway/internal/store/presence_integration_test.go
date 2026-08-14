package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Presence against a REAL Redis.
//
// The unit suite cannot cover this and pretending otherwise would be the whole
// risk: the correctness of expiring presence lives in Redis semantics — ZADD's
// "added" return, ZREMRANGEBYSCORE's exclusive bound, ZSCORE on a missing
// member, and what a TxPipeline does with all of it. A fake would encode this
// package's assumptions rather than test them, and those assumptions are
// exactly what changed when presence stopped being a SET.
//
// Set REDIS_TEST_URL to run. Skipped otherwise, so `go test ./...` on a laptop
// or in a unit-only CI job stays green without a broker:
//
//	docker run -d --rm -p 6399:6379 --name tb-test-redis redis:7-alpine
//	REDIS_TEST_URL=redis://127.0.0.1:6399/0 go test ./internal/store/ -run Integration -v
//
// Every test namespaces its ids, so a shared Redis is fine and the tests can
// run in parallel with anything else pointed at it.
func testStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL not set; skipping Redis integration test")
	}
	s, err := New(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// cleanup removes this test's keys so a shared Redis does not accumulate them
// and a rerun starts from nothing.
func cleanup(t *testing.T, s *Store, orgID string, userIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		keys := []string{orgPresenceKey(orgID)}
		for _, u := range userIDs {
			keys = append(keys, presenceKey(u))
		}
		_ = s.rdb.Del(ctx, keys...).Err()
	})
}

func TestIntegrationPresenceOnlineOfflineTransitions(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	org, user := "org-transitions", "user-transitions"
	cleanup(t, s, org, user)

	// First connection announces; the second must not, or every extra tab
	// re-broadcasts presence.online to the whole org.
	if err := s.AddPresence(ctx, user, "node-1", "conn-a"); err != nil {
		t.Fatalf("AddPresence: %v", err)
	}
	first, err := s.AddOrgPresence(ctx, org, user)
	if err != nil || !first {
		t.Fatalf("first AddOrgPresence: became=%v err=%v, want true", first, err)
	}
	if err := s.AddPresence(ctx, user, "node-1", "conn-b"); err != nil {
		t.Fatalf("AddPresence 2: %v", err)
	}
	second, err := s.AddOrgPresence(ctx, org, user)
	if err != nil || second {
		t.Fatalf("second AddOrgPresence: became=%v err=%v, want false", second, err)
	}

	// Closing one of two tabs must NOT report offline.
	if err := s.RemovePresence(ctx, user, "node-1", "conn-a"); err != nil {
		t.Fatalf("RemovePresence: %v", err)
	}
	off, err := s.RemoveOrgPresenceIfLast(ctx, org, user)
	if err != nil || off {
		t.Fatalf("RemoveOrgPresenceIfLast with one left: became=%v err=%v, want false", off, err)
	}
	online, err := s.OnlineUserIDs(ctx, org)
	if err != nil || len(online) != 1 || online[0] != user {
		t.Fatalf("OnlineUserIDs = %v (err %v), want [%s]", online, err, user)
	}

	// Closing the last one does.
	if err := s.RemovePresence(ctx, user, "node-1", "conn-b"); err != nil {
		t.Fatalf("RemovePresence 2: %v", err)
	}
	off, err = s.RemoveOrgPresenceIfLast(ctx, org, user)
	if err != nil || !off {
		t.Fatalf("RemoveOrgPresenceIfLast on last: became=%v err=%v, want true", off, err)
	}
	online, err = s.OnlineUserIDs(ctx, org)
	if err != nil || len(online) != 0 {
		t.Fatalf("OnlineUserIDs after last close = %v (err %v), want empty", online, err)
	}
}

// The regression this whole rewrite exists for: a node that dies never runs its
// cleanup, so its entries are still in Redis with an old heartbeat. They must
// not keep the user online, and no background job may be required to notice.
func TestIntegrationStalePresenceIsReapedOnRead(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	org, user := "org-stale", "user-stale"
	cleanup(t, s, org, user)

	stale := float64(time.Now().Add(-2 * presenceStaleAfter).UnixMilli())
	// Exactly what a crashed node leaves behind: present in both keys, last
	// heartbeat well in the past, and nothing that will ever remove it.
	if err := s.rdb.ZAdd(ctx, presenceKey(user), redis.Z{Score: stale, Member: "dead-node:conn-x"}).Err(); err != nil {
		t.Fatalf("seed user key: %v", err)
	}
	if err := s.rdb.ZAdd(ctx, orgPresenceKey(org), redis.Z{Score: stale, Member: user}).Err(); err != nil {
		t.Fatalf("seed org key: %v", err)
	}

	online, err := s.OnlineUserIDs(ctx, org)
	if err != nil {
		t.Fatalf("OnlineUserIDs: %v", err)
	}
	if len(online) != 0 {
		t.Fatalf("stale user still reported online: %v", online)
	}

	// Reaped, not merely filtered — the next reader must not have to re-do it.
	n, err := s.rdb.ZCard(ctx, orgPresenceKey(org)).Result()
	if err != nil || n != 0 {
		t.Fatalf("org key still holds %d member(s) (err %v), want 0", n, err)
	}

	fresh, err := s.IsOnlineInOrg(ctx, org, user)
	if err != nil || fresh {
		t.Fatalf("IsOnlineInOrg on stale entry = %v (err %v), want false", fresh, err)
	}
}

// A user stranded by a dead node must be able to come back and be announced.
// If the reap did not run first, ZADD would report "already a member", no
// presence.online would go out, and they would be online in Redis and invisible
// in every colleague's UI.
func TestIntegrationReconnectAfterNodeDeathReAnnounces(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	org, user := "org-revive", "user-revive"
	cleanup(t, s, org, user)

	stale := float64(time.Now().Add(-2 * presenceStaleAfter).UnixMilli())
	if err := s.rdb.ZAdd(ctx, orgPresenceKey(org), redis.Z{Score: stale, Member: user}).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	became, err := s.AddOrgPresence(ctx, org, user)
	if err != nil {
		t.Fatalf("AddOrgPresence: %v", err)
	}
	if !became {
		t.Fatal("reconnect after node death did not announce presence.online")
	}
}

// The heartbeat is what keeps a live socket alive in the eyes of the reaper.
func TestIntegrationTouchKeepsAConnectionFresh(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	org, user := "org-touch", "user-touch"
	cleanup(t, s, org, user)

	stale := float64(time.Now().Add(-2 * presenceStaleAfter).UnixMilli())
	if err := s.rdb.ZAdd(ctx, presenceKey(user), redis.Z{Score: stale, Member: "node-1:conn-a"}).Err(); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := s.rdb.ZAdd(ctx, orgPresenceKey(org), redis.Z{Score: stale, Member: user}).Err(); err != nil {
		t.Fatalf("seed org: %v", err)
	}

	if err := s.TouchPresence(ctx, org, user, "node-1", "conn-a"); err != nil {
		t.Fatalf("TouchPresence: %v", err)
	}

	online, err := s.OnlineUserIDs(ctx, org)
	if err != nil || len(online) != 1 || online[0] != user {
		t.Fatalf("after touch OnlineUserIDs = %v (err %v), want [%s]", online, err, user)
	}
	// Both keys must be refreshed. Touching only the connection key would let a
	// connected user age out of the org view, which is the view /presence reads.
	if score, err := s.rdb.ZScore(ctx, orgPresenceKey(org), user).Result(); err != nil || score <= stale {
		t.Fatalf("org score not refreshed: %v (err %v)", score, err)
	}
}

// Both keys must carry a TTL, or an org that goes quiet leaves them behind
// forever — the unbounded growth the old SET had.
func TestIntegrationPresenceKeysExpire(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	org, user := "org-ttl", "user-ttl"
	cleanup(t, s, org, user)

	if err := s.AddPresence(ctx, user, "node-1", "conn-a"); err != nil {
		t.Fatalf("AddPresence: %v", err)
	}
	if _, err := s.AddOrgPresence(ctx, org, user); err != nil {
		t.Fatalf("AddOrgPresence: %v", err)
	}
	if err := s.TouchPresence(ctx, org, user, "node-1", "conn-a"); err != nil {
		t.Fatalf("TouchPresence: %v", err)
	}

	for name, key := range map[string]string{"user": presenceKey(user), "org": orgPresenceKey(org)} {
		ttl, err := s.rdb.TTL(ctx, key).Result()
		if err != nil {
			t.Fatalf("TTL %s: %v", name, err)
		}
		if ttl <= 0 || ttl > presenceTTL {
			t.Fatalf("%s key TTL = %v, want between 0 and %v", name, ttl, presenceTTL)
		}
	}
}

// Two users in one org must not interfere, and one going offline must not take
// the other with them.
func TestIntegrationOrgPresenceIsPerUser(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	org := "org-multi"
	alice, bob := "user-multi-alice", "user-multi-bob"
	cleanup(t, s, org, alice, bob)

	for _, u := range []string{alice, bob} {
		if err := s.AddPresence(ctx, u, "node-1", "conn-"+u); err != nil {
			t.Fatalf("AddPresence %s: %v", u, err)
		}
		if _, err := s.AddOrgPresence(ctx, org, u); err != nil {
			t.Fatalf("AddOrgPresence %s: %v", u, err)
		}
	}
	online, err := s.OnlineUserIDs(ctx, org)
	if err != nil || len(online) != 2 {
		t.Fatalf("OnlineUserIDs = %v (err %v), want 2", online, err)
	}

	if err := s.RemovePresence(ctx, alice, "node-1", "conn-"+alice); err != nil {
		t.Fatalf("RemovePresence: %v", err)
	}
	if _, err := s.RemoveOrgPresenceIfLast(ctx, org, alice); err != nil {
		t.Fatalf("RemoveOrgPresenceIfLast: %v", err)
	}

	online, err = s.OnlineUserIDs(ctx, org)
	if err != nil || len(online) != 1 || online[0] != bob {
		t.Fatalf("after alice left OnlineUserIDs = %v (err %v), want [%s]", online, err, bob)
	}
}
