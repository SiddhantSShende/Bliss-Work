package server

// reconcilePresence against a REAL Redis.
//
// Same rationale as internal/store/presence_integration_test.go: *store.Store
// wraps a live Redis client with no seam to fake, and the property under test
// — a token renewal's membership delta actually flips real presence keys, not
// just that some Go function got called with the right-shaped arguments — is
// exactly what a mock would beg the question on.
//
// Set REDIS_TEST_URL to run. Skipped otherwise:
//
//	docker run -d --rm -p 6399:6379 --name tb-test-redis redis:7-alpine
//	REDIS_TEST_URL=redis://127.0.0.1:6399/0 go test ./internal/server/ -run ReconcilePresence -v

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

func reconcileTestStore(t *testing.T) *store.Store {
	t.Helper()
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL not set; skipping Redis integration test")
	}
	s, err := store.New(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// ── The bug: auth.renew's membership delta must actually move real presence,
// not just swap the claims pointer ────────────────────────────────────────────
func TestReconcilePresence_MovesRealPresenceForTheDelta(t *testing.T) {
	st := reconcileTestStore(t)
	srv := newTestServer(st, nil)
	srv.nodeID = "test-node"
	ctx := context.Background()

	joinedOrg := uuid.NewString()
	leftOrg := uuid.NewString()
	unchangedOrg := uuid.NewString()
	userInJoined := uuid.NewString()
	userInLeft := uuid.NewString()
	userInUnchanged := uuid.NewString()

	conn := hub.NewConn("u-sender", uuid.NewString())

	// Simulate the state connect-time registration would have left: this
	// socket is already online in leftOrg and unchangedOrg, not yet in
	// joinedOrg.
	for orgID, userID := range map[string]string{leftOrg: userInLeft, unchangedOrg: userInUnchanged} {
		if err := st.AddPresence(ctx, userID, srv.nodeID, conn.ConnID); err != nil {
			t.Fatalf("seed AddPresence(%s): %v", orgID, err)
		}
		if _, err := st.AddOrgPresence(ctx, orgID, userID); err != nil {
			t.Fatalf("seed AddOrgPresence(%s): %v", orgID, err)
		}
	}

	old := []auth.Membership{
		{OrgID: leftOrg, UserID: userInLeft},
		{OrgID: unchangedOrg, UserID: userInUnchanged},
	}
	renewed := []auth.Membership{
		{OrgID: unchangedOrg, UserID: userInUnchanged},
		{OrgID: joinedOrg, UserID: userInJoined},
	}

	srv.reconcilePresence(ctx, conn, old, renewed)

	online, err := st.IsOnlineInOrg(ctx, joinedOrg, userInJoined)
	if err != nil {
		t.Fatalf("IsOnlineInOrg(joinedOrg): %v", err)
	}
	if !online {
		t.Error("joinedOrg: user is not online after a renewal added this membership — " +
			"colleagues in the new org can't see this person connected until a full reconnect")
	}

	online, err = st.IsOnlineInOrg(ctx, leftOrg, userInLeft)
	if err != nil {
		t.Fatalf("IsOnlineInOrg(leftOrg): %v", err)
	}
	if online {
		t.Error("leftOrg: user is STILL online after a renewal removed this membership — " +
			"this is the actual security-relevant bug: they stay reachable for RTC signaling " +
			"in an org they were just removed from, for as long as the socket stays open")
	}

	online, err = st.IsOnlineInOrg(ctx, unchangedOrg, userInUnchanged)
	if err != nil {
		t.Fatalf("IsOnlineInOrg(unchangedOrg): %v", err)
	}
	if !online {
		t.Error("unchangedOrg: user was taken offline despite this membership not changing")
	}
}
