package store

// ActivateDueCalls — the SCHEDULED -> LIVE half of the call sweeper, against a
// real Postgres with RLS actually enforcing.
//
// Same reasoning as calls_lifecycle_db_test.go for why this needs a database
// rather than a unit test: activateCallTx runs under bypass, exactly where
// ExpireOverdueCalls's own RLS regression lived, so a losing bypass here would
// be just as invisible in Go — rows quietly not there, not an error.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see that file's header for how to
// stand one up.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// scheduledCall is a SCHEDULED meeting with a host, seeded directly (bypassing
// the API) since this is the fixture, not the code under test.
type scheduledCall struct {
	id, orgID, host string
}

func seedScheduledCall(t *testing.T, s *Store, scheduledAt *time.Time) scheduledCall {
	t.Helper()
	c := scheduledCall{
		id:    uuid.Must(uuid.NewV7()).String(),
		orgID: uuid.Must(uuid.NewV7()).String(),
		host:  uuid.Must(uuid.NewV7()).String(),
	}
	ctx := context.Background()
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by, scheduled_at, status)
			VALUES ($1, $2, 'MEETING', 'activate test', $3, $4, 'SCHEDULED')`,
			c.id, c.orgID, c.host, scheduledAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role)
			VALUES ($1, $2, $3, $4)`,
			c.id, c.host, c.orgID, RoleHost)
		return err
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, c.id)
			return err
		})
	})
	return c
}

// addWaitingGuest parks a second participant in the call's lobby, the way
// AuthorizeCallAccess does for anyone who arrives before the call is LIVE.
func addWaitingGuest(t *testing.T, s *Store, c scheduledCall) string {
	t.Helper()
	guest := uuid.Must(uuid.NewV7()).String()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, waiting_since)
			VALUES ($1, $2, $3, $4, now())`,
			c.id, guest, c.orgID, RoleParticipant)
		return err
	}); err != nil {
		t.Fatalf("seed waiting guest: %v", err)
	}
	return guest
}

func waitingSince(t *testing.T, s *Store, callID, userID string) *time.Time {
	t.Helper()
	var ws *time.Time
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT waiting_since FROM call_participants WHERE call_id = $1 AND user_id = $2`,
			callID, userID).Scan(&ws)
	}); err != nil {
		t.Fatalf("read waiting_since: %v", err)
	}
	return ws
}

func startedAtOf(t *testing.T, s *Store, callID string) *time.Time {
	t.Helper()
	var sa *time.Time
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT started_at FROM calls WHERE id = $1`, callID).Scan(&sa)
	}); err != nil {
		t.Fatalf("read started_at: %v", err)
	}
	return sa
}

func startedContains(started []ActivatedCall, id string) bool {
	for _, a := range started {
		if a.Call != nil && a.Call.ID == id {
			return true
		}
	}
	return false
}

// A meeting whose scheduled start has already passed must be opened by the
// clock, exactly like StartCall opens one by hand — this is the whole feature:
// nobody has to remember to press Start for a meeting that was put in the
// diary for a specific time.
func TestCallLifecycleDueSweepStartsAScheduledCallAtItsScheduledTime(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedScheduledCall(t, s, ago(time.Minute))

	started, err := s.ActivateDueCalls(ctx, DueSweepLimit)
	if err != nil {
		t.Fatalf("ActivateDueCalls: %v", err)
	}
	if !startedContains(started, c.id) {
		t.Fatalf("the sweep did not report starting %s; it returned %d calls", c.id, len(started))
	}
	if got := callStatus(t, s, c.id); got != CallLive {
		t.Errorf("status = %q, want %q", got, CallLive)
	}
	if startedAtOf(t, s, c.id) == nil {
		t.Error("started_at is still unset after the sweep started the call")
	}
}

// A call scheduled for later must be left exactly as it was — the sweep is not
// allowed to start meetings early just because it happened to run.
func TestCallLifecycleDueSweepLeavesAFutureScheduledCallAlone(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedScheduledCall(t, s, ahead(time.Hour))

	started, err := s.ActivateDueCalls(ctx, DueSweepLimit)
	if err != nil {
		t.Fatalf("ActivateDueCalls: %v", err)
	}
	if startedContains(started, c.id) {
		t.Fatalf("the sweep started %s, which is not due for another hour", c.id)
	}
	if got := callStatus(t, s, c.id); got != CallScheduled {
		t.Errorf("status = %q, want %q — a future call must stay untouched", got, CallScheduled)
	}
}

// Starting a call is also what admits its lobby — a scheduled meeting the
// clock opens must let its early arrivals in exactly like one a host opens by
// hand (StartCall's own clearLobbyTx).
func TestCallLifecycleDueSweepAdmitsWaitingParticipants(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedScheduledCall(t, s, ago(time.Minute))
	guest := addWaitingGuest(t, s, c)

	if _, err := s.ActivateDueCalls(ctx, DueSweepLimit); err != nil {
		t.Fatalf("ActivateDueCalls: %v", err)
	}
	if ws := waitingSince(t, s, c.id, guest); ws != nil {
		t.Errorf("guest is still marked waiting (waiting_since = %v) after the call started", ws)
	}
}

// Running the sweep twice must start a given call once, not twice — the
// UPDATE's own `status = 'SCHEDULED'` guard is what makes that true, the same
// as ExpireOverdueCalls's `status IN (...)` guard for ending.
func TestCallLifecycleDueSweepingTwiceStartsNothingTheSecondTime(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedScheduledCall(t, s, ago(time.Minute))

	first, err := s.ActivateDueCalls(ctx, DueSweepLimit)
	if err != nil {
		t.Fatalf("first ActivateDueCalls: %v", err)
	}
	if !startedContains(first, c.id) {
		t.Fatalf("the first sweep did not start %s", c.id)
	}

	second, err := s.ActivateDueCalls(ctx, DueSweepLimit)
	if err != nil {
		t.Fatalf("second ActivateDueCalls: %v", err)
	}
	if startedContains(second, c.id) {
		t.Errorf("the second sweep reported starting %s again", c.id)
	}
}

// A call that is already LIVE (started by hand, or by an earlier sweep) must
// never be touched by the due-sweep: the UPDATE only ever matches
// status = 'SCHEDULED', so a LIVE row is invisible to it regardless of what
// its scheduled_at says.
func TestCallLifecycleDueSweepLeavesAnAlreadyLiveCallAlone(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	started, err := s.ActivateDueCalls(ctx, DueSweepLimit)
	if err != nil {
		t.Fatalf("ActivateDueCalls: %v", err)
	}
	if startedContains(started, c.id) {
		t.Errorf("the due-sweep reported starting %s, which was already LIVE", c.id)
	}
}
