package store

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"
)

// One person, several organizations, one socket.
//
// A person holds a DIFFERENT users.id in every org they belong to, and an org's
// online set is keyed by that membership id — so a socket that registered only
// its own org left the same human showing offline everywhere else. conn.go now
// drives the calls below once per membership; this is that sequence against a
// real Redis, because what makes it correct is Redis semantics (ZADD's "added"
// return and per-key ZCARD), not our arithmetic.
//
// Requires REDIS_TEST_URL; skipped otherwise. See presence_integration_test.go.

// connect mirrors what conn.go does on socket open, for one membership.
func connect(t *testing.T, s *Store, ctx context.Context, orgID, userID, node, conn string) bool {
	t.Helper()
	if err := s.AddPresence(ctx, userID, node, conn); err != nil {
		t.Fatalf("AddPresence(%s): %v", orgID, err)
	}
	became, err := s.AddOrgPresence(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("AddOrgPresence(%s): %v", orgID, err)
	}
	return became
}

// disconnect mirrors what conn.go does on socket close, for one membership.
func disconnect(t *testing.T, s *Store, ctx context.Context, orgID, userID, node, conn string) bool {
	t.Helper()
	if err := s.RemovePresence(ctx, userID, node, conn); err != nil {
		t.Fatalf("RemovePresence(%s): %v", orgID, err)
	}
	became, err := s.RemoveOrgPresenceIfLast(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("RemoveOrgPresenceIfLast(%s): %v", orgID, err)
	}
	return became
}

func onlineIn(t *testing.T, s *Store, ctx context.Context, orgID, userID string) bool {
	t.Helper()
	ids, err := s.OnlineUserIDs(ctx, orgID)
	if err != nil {
		t.Fatalf("OnlineUserIDs(%s): %v", orgID, err)
	}
	for _, id := range ids {
		if id == userID {
			return true
		}
	}
	return false
}

func TestIntegrationOneSocketPutsThePersonOnlineInEveryOrg(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	const (
		orgA, orgB = "mo-org-a", "mo-org-b"
		meInA      = "mo-me-in-a"
		meInB      = "mo-me-in-b"
		node, conn = "node-1", "conn-1"
	)
	cleanup(t, s, orgA, meInA, meInB)
	cleanup(t, s, orgB, meInA, meInB)

	// One socket, signed in to org A, registering both memberships.
	if became := connect(t, s, ctx, orgA, meInA, node, conn); !became {
		t.Error("org A: expected an absent→present transition on the first socket")
	}
	if became := connect(t, s, ctx, orgB, meInB, node, conn); !became {
		t.Error("org B: expected an absent→present transition — colleagues there " +
			"get no presence.online without it")
	}

	// The whole point of the feature.
	if !onlineIn(t, s, ctx, orgA, meInA) {
		t.Error("person is offline in the org they are signed in to")
	}
	if !onlineIn(t, s, ctx, orgB, meInB) {
		t.Error("person is offline in their OTHER org — this is the bug: they are " +
			"plainly connected and org B cannot see it")
	}

	// Closing the socket withdraws them from both, and each org reports its own
	// present→absent transition so both broadcast a presence.offline.
	if became := disconnect(t, s, ctx, orgA, meInA, node, conn); !became {
		t.Error("org A: expected a present→absent transition on the last socket")
	}
	if became := disconnect(t, s, ctx, orgB, meInB, node, conn); !became {
		t.Error("org B: expected a present→absent transition on the last socket")
	}
	if onlineIn(t, s, ctx, orgA, meInA) || onlineIn(t, s, ctx, orgB, meInB) {
		t.Error("presence survived the last disconnect in at least one org")
	}
}

func TestIntegrationClosingOneTabLeavesTheOtherOrgOnline(t *testing.T) {
	// Two tabs, and the second closes. Presence must survive in BOTH orgs — the
	// per-membership bookkeeping is separate (presence:u: is keyed by membership
	// id), so the risk is one org's teardown being read as the person's last
	// connection everywhere.
	s := testStore(t)
	ctx := context.Background()

	const (
		orgA, orgB = "mo2-org-a", "mo2-org-b"
		meInA      = "mo2-me-in-a"
		meInB      = "mo2-me-in-b"
		node       = "node-1"
	)
	cleanup(t, s, orgA, meInA, meInB)
	cleanup(t, s, orgB, meInA, meInB)

	for _, conn := range []string{"conn-1", "conn-2"} {
		connect(t, s, ctx, orgA, meInA, node, conn)
		connect(t, s, ctx, orgB, meInB, node, conn)
	}

	if became := disconnect(t, s, ctx, orgA, meInA, node, "conn-2"); became {
		t.Error("org A: reported offline while another tab is still open")
	}
	if became := disconnect(t, s, ctx, orgB, meInB, node, "conn-2"); became {
		t.Error("org B: reported offline while another tab is still open")
	}
	if !onlineIn(t, s, ctx, orgA, meInA) || !onlineIn(t, s, ctx, orgB, meInB) {
		t.Error("closing one tab took the person offline somewhere")
	}
}

func TestIntegrationHeartbeatKeepsTheOtherOrgFromAgingOut(t *testing.T) {
	// The org a person is NOT looking at gets no traffic of its own, so its
	// entry ages out of the stale window unless the beat covers it too. That
	// would show them offline in org B while they sit connected in org A —
	// the original bug, arriving two minutes late instead of immediately.
	s := testStore(t)
	ctx := context.Background()

	const (
		orgA, orgB = "mo3-org-a", "mo3-org-b"
		meInA      = "mo3-me-in-a"
		meInB      = "mo3-me-in-b"
		node, conn = "node-1", "conn-1"
	)
	cleanup(t, s, orgA, meInA, meInB)
	cleanup(t, s, orgB, meInB)

	connect(t, s, ctx, orgA, meInA, node, conn)
	connect(t, s, ctx, orgB, meInB, node, conn)

	// Backdate org B's entries to just outside the stale window, as if the beat
	// had skipped it, then beat every membership the way writeLoop now does.
	stale := staleBefore() - 1
	if err := s.rdb.ZAdd(ctx, s.orgPresenceKey(orgB), redis.Z{Score: stale, Member: meInB}).Err(); err != nil {
		t.Fatalf("backdate org set: %v", err)
	}
	if err := s.rdb.ZAdd(ctx, s.presenceKey(meInB), redis.Z{Score: stale, Member: node + ":" + conn}).Err(); err != nil {
		t.Fatalf("backdate user set: %v", err)
	}
	if onlineIn(t, s, ctx, orgB, meInB) {
		t.Fatal("precondition: the backdated entry should have been reaped")
	}

	for _, m := range [][2]string{{orgA, meInA}, {orgB, meInB}} {
		if err := s.TouchPresence(ctx, m[0], m[1], node, conn); err != nil {
			t.Fatalf("TouchPresence(%s): %v", m[0], err)
		}
	}
	if !onlineIn(t, s, ctx, orgB, meInB) {
		t.Error("the heartbeat did not revive org B — a person connected in org A " +
			"still ages out of the orgs they are not looking at")
	}
}
