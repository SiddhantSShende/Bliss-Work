package store

// A page reload closes the OLD socket and opens the NEW one at nearly the same
// moment. The old socket's cleanup (RemoveOrgPresenceIfLast) used to be three
// separate Redis calls — reap, ZCARD, ZREM of the org entry — and the new socket's
// AddPresence/AddOrgPresence could land in the gap after the ZCARD read zero:
//
//	old: ZCARD == 0
//	new: AddPresence; AddOrgPresence (org entry still there -> added == 0 -> no online event)
//	old: ZREM org entry -> "became offline" -> presence.offline published
//
// The user is connected but removed from the org set, and nobody is told otherwise
// until a heartbeat re-adds them, up to 45s later. Real Redis; opt in with
// WS_GATEWAY_TEST_REDIS_URL (the tests skip when it is unreachable).

import (
	"context"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// interleaveHook runs fn exactly once, right after the first command named in
// `after` has completed — i.e. at the precise point where a second socket's
// registration lands between the old socket's check and its removal.
type interleaveHook struct {
	after map[string]bool
	fn    func()
	fired atomic.Bool
}

func (h *interleaveHook) DialHook(next redis.DialHook) redis.DialHook {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		return next(ctx, network, addr)
	}
}

func (h *interleaveHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		err := next(ctx, cmd)
		if h.after[cmd.Name()] && h.fired.CompareAndSwap(false, true) {
			h.fn()
		}
		return err
	}
}

func (h *interleaveHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}

// runReloadRace registers one old socket, then closes it while a new socket for
// the same user registers inside the old socket's check-then-remove window.
func runReloadRace(t *testing.T, st *Store) (oldBecameOffline, newBecameOnline bool, userID, orgID string) {
	t.Helper()
	ctx := context.Background()
	orgID = fmt.Sprintf("org-reload-%d", time.Now().UnixNano())
	userID = orgID + "-user"

	// The old socket is connected and counted online.
	if err := st.AddPresence(ctx, userID, "node-1", "old-conn"); err != nil {
		t.Fatalf("AddPresence(old): %v", err)
	}
	if online, err := st.AddOrgPresence(ctx, orgID, userID); err != nil || !online {
		t.Fatalf("AddOrgPresence(old) = %v, %v; want true, nil", online, err)
	}
	// Its cleanup begins: its connection entry is withdrawn first (conn.go).
	if err := st.RemovePresence(ctx, userID, "node-1", "old-conn"); err != nil {
		t.Fatalf("RemovePresence(old): %v", err)
	}

	hook := &interleaveHook{
		after: map[string]bool{"zcard": true, "evalsha": true, "eval": true},
		fn: func() {
			if err := st.AddPresence(ctx, userID, "node-1", "new-conn"); err != nil {
				t.Errorf("AddPresence(new): %v", err)
			}
			var err error
			if newBecameOnline, err = st.AddOrgPresence(ctx, orgID, userID); err != nil {
				t.Errorf("AddOrgPresence(new): %v", err)
			}
		},
	}
	st.rdb.AddHook(hook)

	var err error
	oldBecameOffline, err = st.RemoveOrgPresenceIfLast(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("RemoveOrgPresenceIfLast: %v", err)
	}
	if !hook.fired.Load() {
		t.Fatal("test hook never fired: the interleaving was not exercised")
	}
	return oldBecameOffline, newBecameOnline, userID, orgID
}

// The invariant a reload must leave behind: a user with a live connection is in
// the org's online set, and the two sockets' transition reports are consistent —
// "offline" was announced only if "online" was announced after it.
func assertReloadConsistent(t *testing.T, st *Store, oldOffline, newOnline bool, userID, orgID string) {
	t.Helper()
	ctx := context.Background()
	conns, err := st.rdb.ZCard(ctx, st.presenceKey(userID)).Result()
	if err != nil || conns != 1 {
		t.Fatalf("connection entries = %d, %v; want exactly the new socket", conns, err)
	}
	if _, err := st.rdb.ZScore(ctx, st.orgPresenceKey(orgID), userID).Result(); err != nil {
		t.Errorf("user has a live socket but is missing from the org online set (%v): shown offline until a heartbeat", err)
	}
	if oldOffline && !newOnline {
		t.Errorf("presence.offline would be published (old socket) with no presence.online after it (new socket): user stuck offline")
	}
}

func TestRemoveOrgPresenceIfLast_ReloadRaceDoesNotShowConnectedUserOffline(t *testing.T) {
	st := testStore(t)
	oldOffline, newOnline, userID, orgID := runReloadRace(t, st)
	assertReloadConsistent(t, st, oldOffline, newOnline, userID, orgID)
}

// The cluster variant cannot be one script (two slots), so it repairs instead;
// force it here against the single test node (tagged keys work there too).
func TestRemoveOrgPresenceIfLast_ClusteredReloadRaceDoesNotShowConnectedUserOffline(t *testing.T) {
	st := testStore(t)
	st.clustered = true
	oldOffline, newOnline, userID, orgID := runReloadRace(t, st)
	assertReloadConsistent(t, st, oldOffline, newOnline, userID, orgID)
}

// The ordinary cases must be unchanged: the last socket closing is an offline
// transition, a remaining socket is not.
func TestRemoveOrgPresenceIfLast_OfflineOnlyWhenLastConnectionGone(t *testing.T) {
	for _, clustered := range []bool{false, true} {
		t.Run(fmt.Sprintf("clustered=%v", clustered), func(t *testing.T) {
			st := testStore(t)
			st.clustered = clustered
			ctx := context.Background()
			orgID := fmt.Sprintf("org-last-%d", time.Now().UnixNano())
			userID := orgID + "-user"
			for _, c := range []string{"a", "b"} {
				if err := st.AddPresence(ctx, userID, "node-1", c); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := st.AddOrgPresence(ctx, orgID, userID); err != nil {
				t.Fatal(err)
			}

			_ = st.RemovePresence(ctx, userID, "node-1", "a")
			if off, err := st.RemoveOrgPresenceIfLast(ctx, orgID, userID); err != nil || off {
				t.Fatalf("first of two sockets closing = %v, %v; want false, nil", off, err)
			}
			if _, err := st.rdb.ZScore(ctx, st.orgPresenceKey(orgID), userID).Result(); err != nil {
				t.Fatalf("user left the org set while a socket remained: %v", err)
			}

			_ = st.RemovePresence(ctx, userID, "node-1", "b")
			if off, err := st.RemoveOrgPresenceIfLast(ctx, orgID, userID); err != nil || !off {
				t.Fatalf("last socket closing = %v, %v; want true, nil", off, err)
			}
			if off, _ := st.RemoveOrgPresenceIfLast(ctx, orgID, userID); off {
				t.Fatal("a second removal reported another offline transition")
			}
		})
	}
}
