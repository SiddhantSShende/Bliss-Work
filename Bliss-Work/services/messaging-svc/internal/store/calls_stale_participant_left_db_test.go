package store

// A stale participant_left for a session a reconnect has since replaced, and
// the session-aware guard that stops it from marking a present user as gone.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug this file exists to catch is a SQL predicate — MarkLeftFromSFU
// closed the roster row on (call_id, user_id) alone, with no way to tell a
// stale echo of an old connection apart from a real departure of the current
// one. Whether the added session_id guard actually changes which row a real
// UPDATE statement touches can only be observed against a real table, not
// reasoned about in Go.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"
)

// ── The bug: a late participant_left for a SUPERSEDED session must not close
// a roster row a newer session has already reclaimed ──────────────────────────
func TestMarkLeftFromSFU_StaleSessionDoesNotClearAReconnectedParticipant(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	// The guest's first connection.
	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "PA_old"); err != nil {
		t.Fatalf("MarkJoinedFromSFU (old session): %v", err)
	}
	// They reconnect — a flaky network, a page reload that keeps the SAME
	// roster row (left_at was never set) but gets a BRAND NEW SFU connection.
	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "PA_new"); err != nil {
		t.Fatalf("MarkJoinedFromSFU (new session): %v", err)
	}

	// The OLD connection's own participant_left webhook arrives late — after
	// the reconnect already landed. This must be recognised as stale.
	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.guest, "PA_old"); err != nil {
		t.Fatalf("MarkLeftFromSFU (stale): %v", err)
	}

	if leftAt := participantLeftAt(t, s, c.id, c.guest); leftAt != nil {
		t.Errorf("left_at = %v after a STALE departure, want nil — the guest's "+
			"current session (PA_new) is still connected", *leftAt)
	}
}

// ── Positive control: a departure of the CURRENT session still closes it ─────
func TestMarkLeftFromSFU_CurrentSessionLeavingStillClosesTheRow(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "PA_current"); err != nil {
		t.Fatalf("MarkJoinedFromSFU: %v", err)
	}
	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.guest, "PA_current"); err != nil {
		t.Fatalf("MarkLeftFromSFU: %v", err)
	}

	if leftAt := participantLeftAt(t, s, c.id, c.guest); leftAt == nil {
		t.Error("left_at is nil after the CURRENT session left, want it set")
	}
}

// ── No join webhook seen yet: NULL session_id matches unconditionally ────────
func TestMarkLeftFromSFU_NoSessionRecordedYetStillCloses(t *testing.T) {
	// Guards the deploy-time transition: rows that predate 0030 (or a call
	// whose join webhook this service never saw) have session_id = NULL, and
	// must not be stuck open forever just because nothing ever populated it.
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.MarkLeftFromSFU(ctx, c.id, c.guest, "PA_whatever"); err != nil {
		t.Fatalf("MarkLeftFromSFU: %v", err)
	}
	if leftAt := participantLeftAt(t, s, c.id, c.guest); leftAt == nil {
		t.Error("left_at is nil, want it set — a NULL session_id must match unconditionally")
	}
}
