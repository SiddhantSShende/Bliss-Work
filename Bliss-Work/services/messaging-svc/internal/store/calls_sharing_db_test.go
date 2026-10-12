package store

// Screen-share concurrency, against a real Postgres with the partial unique
// index actually enforcing it.
//
// ── Why this cannot be a unit test ───────────────────────────────────────────
// The invariant this file exists to catch a regression in — at most one live
// share per CALL, not per (call, user) — is enforced entirely by
// idx_call_screenshares_live_per_call (0037_call_screenshare_one_per_call.sql)
// and the conditional ON CONFLICT ... DO UPDATE ... WHERE in
// StartScreenShare. A mock connection that just records the SQL it was handed
// cannot evaluate a partial unique index or a WHERE clause on a conflicting
// row, so the only way to prove two concurrent requests cannot both win is to
// actually fire them at a database and see which one Postgres lets through.
//
// ── Running it ────────────────────────────────────────────────────────────
// Opt-in, same harness as calls_lifecycle_db_test.go — see that file's header
// for how to stand up MESSAGING_TEST_DATABASE_URL.

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestScreenShare_SecondParticipantBlockedWhileFirstIsSharing(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "monitor"); err != nil {
		t.Fatalf("host starts sharing: %v", err)
	}

	_, err := s.StartScreenShare(ctx, c.orgID, c.guest, c.id, "window")
	if !errors.Is(err, ErrShareAlreadyActive) {
		t.Fatalf("guest start while host is sharing = %v, want ErrShareAlreadyActive", err)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 1 || active[0].UserID != c.host {
		t.Fatalf("active shares = %+v, want exactly the host's", active)
	}
}

func TestScreenShare_ConcurrentStarts_ExactlyOneSucceeds(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, user := range []string{c.host, c.guest} {
		wg.Add(1)
		go func(userID string) {
			defer wg.Done()
			<-start
			_, err := s.StartScreenShare(ctx, c.orgID, userID, c.id, "monitor")
			results <- err
		}(user)
	}
	close(start)
	wg.Wait()
	close(results)

	succeeded, conflicted := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrShareAlreadyActive):
			conflicted++
		default:
			t.Fatalf("concurrent start: %v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("concurrent starts: %d succeeded, %d conflicted; want exactly one of each", succeeded, conflicted)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 1 {
		t.Fatalf("active shares after the race = %+v, want exactly one row", active)
	}
}

func TestScreenShare_SecondParticipantCanStartAfterFirstStops(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "monitor"); err != nil {
		t.Fatalf("host starts sharing: %v", err)
	}
	stopped, err := s.StopScreenShare(ctx, c.orgID, c.host, c.id)
	if err != nil || !stopped {
		t.Fatalf("host stops sharing: stopped=%v err=%v, want true, nil", stopped, err)
	}

	if _, err := s.StartScreenShare(ctx, c.orgID, c.guest, c.id, "window"); err != nil {
		t.Fatalf("guest starts after host stopped: %v", err)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 1 || active[0].UserID != c.guest {
		t.Fatalf("active shares = %+v, want exactly the guest's", active)
	}
}

func TestScreenShare_DuplicateAndStaleStopsAreIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	// A stop before anyone ever started is the same "not sharing" end state
	// that already holds — not an error.
	stopped, err := s.StopScreenShare(ctx, c.orgID, c.host, c.id)
	if err != nil || stopped {
		t.Fatalf("stop with nothing to stop: stopped=%v err=%v, want false, nil", stopped, err)
	}

	if _, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "monitor"); err != nil {
		t.Fatalf("host starts sharing: %v", err)
	}

	first, err := s.StopScreenShare(ctx, c.orgID, c.host, c.id)
	if err != nil || !first {
		t.Fatalf("first stop: stopped=%v err=%v, want true, nil", first, err)
	}
	// The duplicate/retried stop a lost response or a double-submit produces.
	second, err := s.StopScreenShare(ctx, c.orgID, c.host, c.id)
	if err != nil || second {
		t.Fatalf("duplicate stop: stopped=%v err=%v, want false, nil (not 409)", second, err)
	}

	// And it must not have touched anyone else's share.
	if _, err := s.StartScreenShare(ctx, c.orgID, c.guest, c.id, "window"); err != nil {
		t.Fatalf("guest starts after host's share is gone: %v", err)
	}
	dupAgainstGuest, err := func() (bool, error) { return s.StopScreenShare(ctx, c.orgID, c.host, c.id) }()
	if err != nil || dupAgainstGuest {
		t.Fatalf("host's stale stop after guest started: stopped=%v err=%v, want false, nil (guest's share must survive)", dupAgainstGuest, err)
	}
	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 1 || active[0].UserID != c.guest {
		t.Fatalf("active shares after host's stale stop = %+v, want the guest's share untouched", active)
	}
}

func TestScreenShare_SameUserReDeclareUpdatesSourceInPlace(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	first, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "monitor")
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	second, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "window")
	if err != nil {
		t.Fatalf("same user re-declaring (switched window): %v", err)
	}
	if second.ID != first.ID || second.StartedAt != first.StartedAt {
		t.Fatalf("re-declare = %+v, want the SAME id/startedAt as %+v (one session, not two)", second, first)
	}
	if second.Source != ShareWindow {
		t.Fatalf("re-declare source = %q, want %q", second.Source, ShareWindow)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 1 {
		t.Fatalf("active shares after re-declare = %+v, want exactly one row (no duplicate)", active)
	}
}

func TestScreenShare_EndCallClosesEveryoneSLiveShare(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.StartScreenShare(ctx, c.orgID, c.guest, c.id, "monitor"); err != nil {
		t.Fatalf("guest starts sharing: %v", err)
	}
	if _, err := s.EndCall(ctx, c.orgID, c.host, c.id); err != nil {
		t.Fatalf("host ends the call: %v", err)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("active shares after EndCall = %+v, want none", active)
	}
}

// A non-host leaving must free the slot without ending the call — only a
// HOST's departure can do that (endsCallOnLeave) — so the remaining
// participant can then start sharing in the SAME still-live call.
func TestScreenShare_NonHostLeaveClosesOnlyTheirOwnShareAndFreesTheSlot(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.StartScreenShare(ctx, c.orgID, c.guest, c.id, "monitor"); err != nil {
		t.Fatalf("guest starts sharing: %v", err)
	}

	recorded, wasSharing, ended, err := s.LeaveCall(ctx, c.orgID, c.guest, c.id)
	if err != nil {
		t.Fatalf("guest leaves: %v", err)
	}
	if !recorded || !wasSharing || ended != nil {
		t.Fatalf("guest leave: recorded=%v wasSharing=%v ended=%v, want true, true, nil (non-host leave must not end the call)", recorded, wasSharing, ended)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("active shares after the sharer leaves = %+v, want none", active)
	}

	if _, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "window"); err != nil {
		t.Fatalf("host starts sharing in the still-live call after guest left: %v", err)
	}
}

// The SFU's own participant_left webhook (an unannounced departure — the
// browser closed rather than a leave click) must free the slot exactly like
// an explicit leave does.
func TestScreenShare_SFUDisconnectWebhookClosesShareAndFreesTheSlot(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if _, err := s.StartScreenShare(ctx, c.orgID, c.guest, c.id, "monitor"); err != nil {
		t.Fatalf("guest starts sharing: %v", err)
	}

	recorded, wasSharing, err := s.MarkLeftFromSFU(ctx, c.id, c.guest, "")
	if err != nil {
		t.Fatalf("SFU-reported disconnect: %v", err)
	}
	if !recorded || !wasSharing {
		t.Fatalf("SFU disconnect: recorded=%v wasSharing=%v, want true, true", recorded, wasSharing)
	}

	active, err := s.ActiveShares(ctx, c.orgID, c.id)
	if err != nil {
		t.Fatalf("active shares: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("active shares after the SFU reports the sharer gone = %+v, want none", active)
	}

	if _, err := s.StartScreenShare(ctx, c.orgID, c.host, c.id, "window"); err != nil {
		t.Fatalf("host starts sharing after the SFU freed the slot: %v", err)
	}
}

// ActiveShares exposes activeSharesTx for tests outside the store package's
// own transactions — it opens its own read-only one.
func (s *Store) ActiveShares(ctx context.Context, orgID, callID string) ([]CallShareDTO, error) {
	var out []CallShareDTO
	err := s.withCaller(ctx, orgID, "", func(tx pgx.Tx) error {
		rows, err := activeSharesTx(ctx, tx, callID)
		out = rows
		return err
	})
	return out, err
}
