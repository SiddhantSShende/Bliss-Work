package store

// A live socket's presence key must have its TTL re-armed on a regular cadence of
// ITS OWN beats, whatever the other sockets in the process are doing. Real Redis;
// opt in with WS_GATEWAY_TEST_REDIS_URL (the tests skip when it is unreachable).
//
// The TTL refresh is sampled (one beat in ttlRefreshEveryN) to cut EXPIRE traffic.
// The sample used to be taken from ONE counter shared by every socket in the
// process, so which sockets got refreshed depended on how the beats happened to
// interleave: with the sockets beating in a fixed order a given socket was either
// always the sampled one or never, and one that never was lost its presence key
// when the 10-minute TTL ran out — the user disappeared from routing (live pushes
// skipped as "unroutable") until their next heartbeat re-created the key.

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("WS_GATEWAY_TEST_REDIS_URL")
	if url == "" {
		url = "redis://127.0.0.1:16379/0"
	}
	st, err := New(url)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := st.Ping(ctx); err != nil {
		t.Skipf("test redis unreachable at %s (set WS_GATEWAY_TEST_REDIS_URL): %v", url, err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestTouchPresence_EverySocketReArmsItsOwnKeyTTL(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	const sockets = 4 // a multiple of ttlRefreshEveryN: the worst case for a shared counter
	orgID := fmt.Sprintf("org-ttl-%d", time.Now().UnixNano())

	users := make([]string, sockets)
	for i := range users {
		users[i] = fmt.Sprintf("%s-user-%d", orgID, i)
		if err := st.AddPresence(ctx, users[i], "node-1", fmt.Sprintf("conn-%d", i)); err != nil {
			t.Fatalf("AddPresence: %v", err)
		}
		// Time has passed since connect: the key is close to expiring.
		if err := st.rdb.Expire(ctx, st.presenceKey(users[i]), 100*time.Second).Err(); err != nil {
			t.Fatalf("shorten ttl: %v", err)
		}
	}

	// One full refresh cycle of beats, every socket beating in the same order each round.
	for beat := 1; beat <= ttlRefreshEveryN; beat++ {
		for i, user := range users {
			if err := touch(st, orgID, user, fmt.Sprintf("conn-%d", i), uint64(beat)); err != nil {
				t.Fatalf("TouchPresence: %v", err)
			}
		}
	}

	for i, user := range users {
		ttl, err := st.rdb.TTL(ctx, st.presenceKey(user)).Result()
		if err != nil {
			t.Fatalf("TTL: %v", err)
		}
		if ttl <= 100*time.Second {
			t.Errorf("socket %d's presence key still has %v left after a full refresh cycle of its own beats; it was never re-armed", i, ttl)
		}
	}
}

// The relationship presence.go's ttlRefreshEveryN comment promises: at least two
// full refresh cycles fit inside the TTL, so one cycle lost to a Redis blip does not
// expire a live socket's key. Asserted on the relationship, not on the numbers.
func TestRefreshesTTL_TwoFullCyclesFitInsideTheExpiryWindow(t *testing.T) {
	if !refreshesTTL(1) {
		t.Fatal("a connection's first beat must arm the TTLs")
	}
	last, longestGap := uint64(1), uint64(0)
	for beat := uint64(2); beat <= 1000; beat++ {
		if refreshesTTL(beat) {
			if gap := beat - last; gap > longestGap {
				longestGap = gap
			}
			last = beat
		}
	}
	if longestGap == 0 {
		t.Fatal("the TTL is never re-armed after the first beat")
	}
	if cycle := time.Duration(longestGap) * PresenceHeartbeatInterval; 2*cycle > presenceTTL {
		t.Fatalf("a refresh cycle is %v; two of them do not fit inside the %v presence TTL", cycle, presenceTTL)
	}
}
