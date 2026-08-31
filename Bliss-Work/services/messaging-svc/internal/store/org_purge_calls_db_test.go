package store

// PurgeOrg's coverage of the calls subsystem, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// orgPurgeTables omitting calls/call_recordings/call_invites/call_screenshares
// entirely, and call_participants needing TWO delete predicates instead of one
// (its org_id is the PARTICIPANT's own org, not the call's hosting org — see
// 0015_calls.sql), are both facts about real rows in a real schema. A mock
// store would happily "purge" whatever the test told it to and prove nothing
// about whether the actual table list is complete or the actual WHERE clause
// reaches every row it needs to.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedCall inserts a minimal calls row directly, hosted by hostOrg.
func seedCall(t *testing.T, s *Store, hostOrg string) string {
	t.Helper()
	id := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO calls (id, org_id, kind, created_by, status)
			VALUES ($1, $2, 'MEETING', $3, 'SCHEDULED')`,
			id, hostOrg, uuid.Must(uuid.NewV7()).String())
		return err
	}); err != nil {
		t.Fatalf("seed call: %v", err)
	}
	return id
}

// seedParticipant inserts a call_participants row for participantOrg — which,
// for a cross-org guest, is deliberately NOT the call's hosting org.
func seedParticipant(t *testing.T, s *Store, callID, participantOrg string) string {
	t.Helper()
	userID := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO call_participants (call_id, user_id, org_id, role)
			VALUES ($1, $2, $3, 'PARTICIPANT')`,
			callID, userID, participantOrg)
		return err
	}); err != nil {
		t.Fatalf("seed participant: %v", err)
	}
	return userID
}

func callParticipantExists(t *testing.T, s *Store, callID, userID string) bool {
	t.Helper()
	var exists bool
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT EXISTS (SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2)`,
			callID, userID).Scan(&exists)
	}); err != nil {
		t.Fatalf("check call_participants: %v", err)
	}
	return exists
}

func callExists(t *testing.T, s *Store, callID string) bool {
	t.Helper()
	var exists bool
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT EXISTS (SELECT 1 FROM calls WHERE id = $1)`, callID).Scan(&exists)
	}); err != nil {
		t.Fatalf("check calls: %v", err)
	}
	return exists
}

// ── The bug: purging an org left its own calls (and their child tables)
// completely untouched ────────────────────────────────────────────────────────
func TestPurgeOrg_DeletesCallsHostedByTheOrg(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	callID := seedCall(t, s, orgID)

	deleted, err := s.PurgeOrg(context.Background(), orgID)
	if err != nil {
		t.Fatalf("PurgeOrg: %v", err)
	}
	if deleted["calls"] != 1 {
		t.Errorf(`PurgeOrg deleted["calls"] = %d, want 1`, deleted["calls"])
	}
	if callExists(t, s, callID) {
		t.Error("call still exists after its hosting org was purged")
	}
}

// ── call_participants needs BOTH predicates: the purged org's own user in
// ANOTHER org's call, and a cross-org guest in THIS org's call ─────────────────
func TestPurgeOrg_DeletesCallParticipantsBothWays(t *testing.T) {
	s := lifecycleStore(t)
	purgedOrg := uuid.Must(uuid.NewV7()).String()
	otherOrg := uuid.Must(uuid.NewV7()).String()

	// Case 1: a call hosted by otherOrg; purgedOrg's own user attended as a
	// participant (their call_participants.org_id = purgedOrg).
	otherOrgsCall := seedCall(t, s, otherOrg)
	purgedOrgsUserElsewhere := seedParticipant(t, s, otherOrgsCall, purgedOrg)

	// Case 2: a call hosted by purgedOrg; a guest from otherOrg attended
	// (their call_participants.org_id = otherOrg, NOT purgedOrg).
	purgedOrgsCall := seedCall(t, s, purgedOrg)
	otherOrgsGuest := seedParticipant(t, s, purgedOrgsCall, otherOrg)

	// Control: otherOrg's call, otherOrg's own participant — must survive.
	otherOrgsOwnUser := seedParticipant(t, s, otherOrgsCall, otherOrg)

	if _, err := s.PurgeOrg(context.Background(), purgedOrg); err != nil {
		t.Fatalf("PurgeOrg: %v", err)
	}

	if callParticipantExists(t, s, otherOrgsCall, purgedOrgsUserElsewhere) {
		t.Error("purged org's own user still a participant in another org's call")
	}
	if callParticipantExists(t, s, purgedOrgsCall, otherOrgsGuest) {
		t.Error("cross-org guest's participation in the purged org's own call still exists")
	}
	if !callParticipantExists(t, s, otherOrgsCall, otherOrgsOwnUser) {
		t.Error("an unrelated org's own participant row was deleted by purging a DIFFERENT org")
	}
}

// ── call_recordings/call_invites/call_screenshares are all hosting-org scoped
// and must be purged with a plain org_id filter ──────────────────────────────
func TestPurgeOrg_DeletesRecordingsInvitesAndScreenshares(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	callID := seedCall(t, s, orgID)
	ctx := context.Background()

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_recordings (id, call_id, org_id, egress_id, status)
			VALUES ($1, $2, $3, $4, 'READY')`,
			uuid.Must(uuid.NewV7()).String(), callID, orgID, "EG_"+uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_invites (id, call_id, org_id, token_hash, created_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
			uuid.Must(uuid.NewV7()).String(), callID, orgID, []byte(uuid.Must(uuid.NewV7()).String()), uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO call_screenshares (id, call_id, user_id, org_id, source)
			VALUES ($1, $2, $3, $4, 'SCREEN')`,
			uuid.Must(uuid.NewV7()).String(), callID, uuid.Must(uuid.NewV7()).String(), orgID)
		return err
	}); err != nil {
		t.Fatalf("seed call children: %v", err)
	}

	deleted, err := s.PurgeOrg(ctx, orgID)
	if err != nil {
		t.Fatalf("PurgeOrg: %v", err)
	}
	for _, table := range []string{"call_recordings", "call_invites", "call_screenshares"} {
		if deleted[table] != 1 {
			t.Errorf("PurgeOrg deleted[%q] = %d, want 1", table, deleted[table])
		}
	}
}
