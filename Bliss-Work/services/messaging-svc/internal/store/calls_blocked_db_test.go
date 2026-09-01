package store

// CreateDirectCall's block enforcement (P0-A) and IsBlockedPair, against a
// real Postgres with RLS actually enforcing.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The rule under test is a JOIN across conversations + conversation_members
// scoped by an RLS-enforced app.org_id GUC, executed against a transaction
// CreateDirectCall already has open (blockedPairTx) rather than one of its
// own. A fake pgx.Tx would prove the SQL parses, not that it reads the right
// rows under RLS or that CreateDirectCall's tx sees Block's committed write.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it, e.g.:
//
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run TestCreateDirectCall -v
//	MESSAGING_TEST_DATABASE_URL='...' go test ./internal/store/ -run TestIsBlockedPair -v

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// seedCallPeers seeds two org-mates in user_projection — CreateDirectCall's
// peerOrg lookup requires this row to exist before it will even reach the
// block check.
func seedCallPeers(t *testing.T, s *Store, orgID string) (caller, peer string) {
	t.Helper()
	caller, peer = uuid.Must(uuid.NewV7()).String(), uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, caller, "caller", "Caller")
	seedUser(t, s, orgID, peer, "peer", "Peer")
	return caller, peer
}

// ── Test 1 & 2: either direction of block refuses the call ────────────────────

func TestCreateDirectCall_RefusedWhenCallerBlockedRecipient(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller, peer := seedCallPeers(t, s, orgID)

	if err := s.Block(ctx, orgID, caller, peer); err != nil {
		t.Fatalf("caller blocks peer: %v", err)
	}

	_, err := s.CreateDirectCall(ctx, orgID, caller, peer, "", "video", nil, nil)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("CreateDirectCall with caller having blocked the peer = %v, want ErrForbidden", err)
	}
}

func TestCreateDirectCall_RefusedWhenRecipientBlockedCaller(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller, peer := seedCallPeers(t, s, orgID)

	// The PEER blocks the caller — the block row is on the other member, and
	// the rule must still refuse the caller's call (bool_or over BOTH rows).
	if err := s.Block(ctx, orgID, peer, caller); err != nil {
		t.Fatalf("peer blocks caller: %v", err)
	}

	_, err := s.CreateDirectCall(ctx, orgID, caller, peer, "", "video", nil, nil)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("CreateDirectCall against a caller the recipient blocked = %v, want ErrForbidden", err)
	}
}

// ── Test 3: no block, call succeeds (and Test 6: same org, no block) ──────────

func TestCreateDirectCall_SucceedsWithNoBlock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller, peer := seedCallPeers(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, caller, peer, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall with no block relationship: %v", err)
	}
	if call == nil || call.ID == "" {
		t.Fatalf("CreateDirectCall returned no call: %+v", call)
	}
}

// An unblock must actually restore calling — asserts the fix reads live state,
// not a memoized answer from the block check.
func TestCreateDirectCall_SucceedsAfterUnblock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller, peer := seedCallPeers(t, s, orgID)

	if err := s.Block(ctx, orgID, caller, peer); err != nil {
		t.Fatalf("block: %v", err)
	}
	if _, err := s.CreateDirectCall(ctx, orgID, caller, peer, "", "video", nil, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("call while blocked = %v, want ErrForbidden", err)
	}

	if err := s.Unblock(ctx, orgID, caller, peer); err != nil {
		t.Fatalf("unblock: %v", err)
	}
	if _, err := s.CreateDirectCall(ctx, orgID, caller, peer, "", "video", nil, nil); err != nil {
		t.Fatalf("call after unblock: %v, want success", err)
	}
}

// A pair that has never exchanged a message (no conversation row at all) must
// not be treated as blocked — bool_or over zero matched rows is NULL, and the
// query must coalesce that to false, not error or refuse.
func TestCreateDirectCall_SucceedsWithNoPriorConversation(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller, peer := seedCallPeers(t, s, orgID)

	if _, err := s.CreateDirectCall(ctx, orgID, caller, peer, "", "video", nil, nil); err != nil {
		t.Fatalf("call between two users with no prior conversation: %v, want success", err)
	}
}

// ── Test 7: cross-org calling keeps its existing (unrelated) refusal ──────────
// The block check must not mask or change the pre-existing cross-org gate —
// a cross-org peer is refused at the org check, before the block check ever
// runs, exactly as before this change.

func TestCreateDirectCall_CrossOrgStillRefused(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgA := uuid.Must(uuid.NewV7()).String()
	orgB := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	peer := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgA, caller, "caller", "Caller")
	seedUser(t, s, orgB, peer, "peer", "Peer")

	_, err := s.CreateDirectCall(ctx, orgA, caller, peer, "", "video", nil, nil)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-org CreateDirectCall = %v, want ErrForbidden (unchanged pre-existing behavior)", err)
	}
}

// ── IsBlockedPair directly ─────────────────────────────────────────────────────

func TestIsBlockedPair_TrueEitherDirection(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b := seedCallPeers(t, s, orgID)

	if blocked, err := s.IsBlockedPair(ctx, orgID, a, b); err != nil || blocked {
		t.Fatalf("IsBlockedPair before any block = (%v, %v), want (false, nil)", blocked, err)
	}

	if err := s.Block(ctx, orgID, b, a); err != nil { // b blocks a
		t.Fatalf("block: %v", err)
	}
	// Asked in either argument order, the answer must be the same.
	if blocked, err := s.IsBlockedPair(ctx, orgID, a, b); err != nil || !blocked {
		t.Fatalf("IsBlockedPair(a,b) after b blocked a = (%v, %v), want (true, nil)", blocked, err)
	}
	if blocked, err := s.IsBlockedPair(ctx, orgID, b, a); err != nil || !blocked {
		t.Fatalf("IsBlockedPair(b,a) after b blocked a = (%v, %v), want (true, nil)", blocked, err)
	}
}

func TestIsBlockedPair_FalseWithNoConversation(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b := seedCallPeers(t, s, orgID)

	blocked, err := s.IsBlockedPair(ctx, orgID, a, b)
	if err != nil {
		t.Fatalf("IsBlockedPair with no conversation: %v", err)
	}
	if blocked {
		t.Fatal("IsBlockedPair reported blocked for a pair with no conversation at all")
	}
}
