package store

// endCallTx's roster close-out, for a cross-org meeting guest, against a real
// Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug this file exists to catch was invisible without real RLS: the
// close-out UPDATE compiled, ran, and reported success on the SAME-ORG rows
// every time — the failure mode is which rows it silently DIDN'T match under
// the host's own org-scoped transaction, and that can only be observed
// against the real policy. See calls_lifecycle_db_test.go's header for the
// harness (opt-in via MESSAGING_TEST_DATABASE_URL) and how to run it, and
// calls_lobby.go's clearLobbyTx for the sibling fix this mirrors.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// crossOrgCall seeds one LIVE meeting hosted by hostOrg, with the host and a
// GENUINELY cross-org guest (a different org_id on their call_participants
// row) both joined — unlike seedLiveCall's guest, which shares the host's org.
type crossOrgCall struct {
	id, hostOrg, host, guestOrg, guest string
}

func seedCrossOrgCall(t *testing.T, s *Store) crossOrgCall {
	t.Helper()
	c := crossOrgCall{
		id:       uuid.Must(uuid.NewV7()).String(),
		hostOrg:  uuid.Must(uuid.NewV7()).String(),
		host:     uuid.Must(uuid.NewV7()).String(),
		guestOrg: uuid.Must(uuid.NewV7()).String(),
		guest:    uuid.Must(uuid.NewV7()).String(),
	}
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by, started_at, status)
			VALUES ($1, $2, 'MEETING', 'cross-org test', $3, now() - interval '10 minutes', 'LIVE')`,
			c.id, c.hostOrg, c.host); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at)
			VALUES ($1, $2, $3, 'HOST', now() - interval '10 minutes')`,
			c.id, c.host, c.hostOrg); err != nil {
			return err
		}
		// The guest's org_id is their OWN org, not the call's hosting org — see
		// 0015_calls.sql. That is what makes this row invisible under the
		// host's own RLS-scoped transaction without the bypass fix.
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at)
			VALUES ($1, $2, $3, 'PARTICIPANT', now() - interval '10 minutes')`,
			c.id, c.guest, c.guestOrg)
		return err
	}); err != nil {
		t.Fatalf("seed cross-org call: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, c.id)
			return err
		})
	})
	return c
}

func participantLeftAt(t *testing.T, s *Store, callID, userID string) *time.Time {
	t.Helper()
	ctx := context.Background()
	var leftAt *time.Time
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT left_at FROM call_participants WHERE call_id = $1 AND user_id = $2`,
			callID, userID).Scan(&leftAt)
	}); err != nil {
		t.Fatalf("read left_at: %v", err)
	}
	return leftAt
}

// ── The bug: EndCall (host's own org-scoped transaction) must still close out
// a cross-org guest's roster row ──────────────────────────────────────────────
func TestEndCall_ClosesOutCrossOrgGuestsRosterRow(t *testing.T) {
	s := lifecycleStore(t)
	c := seedCrossOrgCall(t, s)
	ctx := context.Background()

	if _, err := s.EndCall(ctx, c.hostOrg, c.host, c.id); err != nil {
		t.Fatalf("EndCall: %v", err)
	}

	if callStatus(t, s, c.id) != "ENDED" {
		t.Fatalf("call status after EndCall, want ENDED")
	}
	if left := participantLeftAt(t, s, c.id, c.guest); left == nil {
		t.Error("cross-org guest's left_at is still NULL after EndCall — they show as still " +
			"in a meeting the data says is over")
	}
	if left := participantLeftAt(t, s, c.id, c.host); left == nil {
		t.Error("host's own left_at is still NULL after EndCall (sanity check on the same-org path)")
	}
}

// ── Same bug, via the host's Leave (LeaveCall ends the call when the leaver
// hosts it) ────────────────────────────────────────────────────────────────
func TestLeaveCall_HostLeaving_ClosesOutCrossOrgGuestsRosterRow(t *testing.T) {
	s := lifecycleStore(t)
	c := seedCrossOrgCall(t, s)
	ctx := context.Background()

	_, ended, err := s.LeaveCall(ctx, c.hostOrg, c.host, c.id)
	if err != nil {
		t.Fatalf("LeaveCall: %v", err)
	}
	if ended == nil {
		t.Fatal("LeaveCall did not report the call as ended — the host leaving a call with no " +
			"other host present should end it")
	}

	if left := participantLeftAt(t, s, c.id, c.guest); left == nil {
		t.Error("cross-org guest's left_at is still NULL after the host's Leave ended the call")
	}
}
