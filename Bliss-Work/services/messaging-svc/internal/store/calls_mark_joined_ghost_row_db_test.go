package store

// MarkJoined's status guard, against a real Postgres — the race where the host
// ends a call (or the sweeper expires it) in the window between
// AuthorizeCallAccess granting a token and callToken's follow-up MarkJoined
// call actually landing.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug was an UPDATE with no status guard at all: it ran, matched a row,
// and reported success every time, regardless of what calls.status said at
// that instant. Whether the added guard actually changes which rows the
// UPDATE matches — and leaves untouched — can only be observed against a real
// table, not reasoned about in Go.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedEndedCallWithUnjoinedParticipant reproduces the exact shape the race
// leaves behind: a call that is already ENDED, and a participant row on its
// roster that was seated but never actually joined — joined_at and left_at
// both NULL, the same shape as anyone holding a valid room token who has not
// yet reached the line this test is about.
//
// endCallTx's own close-out only touches rows where joined_at IS NOT NULL
// (see its doc comment in calls.go), so a row in this shape survives ending
// the call untouched — which is exactly what makes it possible for a LATE
// MarkJoined to resurrect it as an open row on a call that is already over.
func seedEndedCallWithUnjoinedParticipant(t *testing.T, s *Store) (callID, orgID, participant string) {
	t.Helper()
	callID = uuid.Must(uuid.NewV7()).String()
	orgID = uuid.Must(uuid.NewV7()).String()
	host := uuid.Must(uuid.NewV7()).String()
	participant = uuid.Must(uuid.NewV7()).String()
	ctx := context.Background()
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by, started_at, ended_at, status)
			VALUES ($1, $2, 'MEETING', 'mark-joined race test', $3,
			        now() - interval '10 minutes', now(), 'ENDED')`,
			callID, orgID, host); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at, left_at)
			VALUES ($1, $2, $3, 'HOST', now() - interval '10 minutes', now())`,
			callID, host, orgID); err != nil {
			return err
		}
		// The row the race leaves behind: seated on the roster, never joined.
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role)
			VALUES ($1, $2, $3, 'PARTICIPANT')`,
			callID, participant, orgID)
		return err
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, derr := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, callID)
			return derr
		})
	})
	return callID, orgID, participant
}

func participantJoinedAt(t *testing.T, s *Store, callID, userID string) *time.Time {
	t.Helper()
	ctx := context.Background()
	var joinedAt *time.Time
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT joined_at FROM call_participants WHERE call_id = $1 AND user_id = $2`,
			callID, userID).Scan(&joinedAt)
	}); err != nil {
		t.Fatalf("read joined_at: %v", err)
	}
	return joinedAt
}

// ── The bug: a token request that lands after the call has already ended
// must not open a fresh roster row on it ─────────────────────────────────────
func TestMarkJoined_DoesNotOpenARosterRowOnAnAlreadyEndedCall(t *testing.T) {
	s := lifecycleStore(t)
	callID, orgID, participant := seedEndedCallWithUnjoinedParticipant(t, s)
	ctx := context.Background()

	err := s.MarkJoined(ctx, orgID, participant, callID)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("MarkJoined on an ended call = %v, want ErrForbidden", err)
	}
	if joinedAt := participantJoinedAt(t, s, callID, participant); joinedAt != nil {
		t.Errorf("joined_at = %v after MarkJoined on an ended call, want nil — this is the "+
			"ghost open row: joined_at set, left_at NULL, on a call that is already over", *joinedAt)
	}
	if n := openParticipants(t, s, callID); n != 0 {
		t.Errorf("%d open participant rows on an ended call after MarkJoined, want 0", n)
	}
}

// ── Positive control: the ordinary case, MarkJoined on a call that is still
// LIVE, must keep working exactly as before ──────────────────────────────────
func TestMarkJoined_StillStampsAttendanceOnALiveCall(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)
	guest := uuid.Must(uuid.NewV7()).String()
	// A participant seated on a still-LIVE call's roster but not yet
	// joined — the ordinary shape a fresh arrival's row has right before
	// their own MarkJoined call lands.
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role)
			VALUES ($1, $2, $3, 'PARTICIPANT')`, c.id, guest, c.orgID)
		return err
	}); err != nil {
		t.Fatalf("seed extra participant: %v", err)
	}

	if err := s.MarkJoined(ctx, c.orgID, guest, c.id); err != nil {
		t.Fatalf("MarkJoined on a live call: %v, want success", err)
	}
	if joinedAt := participantJoinedAt(t, s, c.id, guest); joinedAt == nil {
		t.Error("joined_at is nil after MarkJoined on a live call, want it stamped")
	}
}
