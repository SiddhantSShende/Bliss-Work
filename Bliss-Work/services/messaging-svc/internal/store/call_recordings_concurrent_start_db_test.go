package store

// StartRecording under genuine concurrency, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug this file exists to catch is a missing DATABASE constraint:
// AuthorizeRecordingControl checks who may start a recording, never whether
// one is already running, so two concurrent "start recording" requests both
// pass it, both mint a real LiveKit egress with a distinct egress_id, and the
// existing ON CONFLICT (egress_id) never fires for either — nothing in Go
// stops two rows from landing as RECORDING for one call. Only a real unique
// index, exercised by two genuinely concurrent transactions, can prove the
// second one is rejected rather than merely reasoned about.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedLiveCallForRecording inserts a bare LIVE meeting — no participants
// needed, since StartRecording itself (unlike AuthorizeRecordingControl)
// only reads the calls row for org_id.
func seedLiveCallForRecording(t *testing.T, s *Store) (callID string) {
	t.Helper()
	callID = uuid.Must(uuid.NewV7()).String()
	orgID := uuid.Must(uuid.NewV7()).String()
	host := uuid.Must(uuid.NewV7()).String()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by, started_at, status)
			VALUES ($1, $2, 'MEETING', 'recording race test', $3, now(), 'LIVE')`,
			callID, orgID, host)
		return err
	}); err != nil {
		t.Fatalf("seed live call: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, callID)
			return err
		})
	})
	return callID
}

func recordingStatusesForCall(t *testing.T, s *Store, callID string) []string {
	t.Helper()
	ctx := context.Background()
	var statuses []string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT status FROM call_recordings WHERE call_id = $1 ORDER BY started_at`, callID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var st string
			if err := rows.Scan(&st); err != nil {
				return err
			}
			statuses = append(statuses, st)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read call_recordings: %v", err)
	}
	return statuses
}

// ── The bug: two concurrent starts must not both land as RECORDING ───────────
func TestStartRecording_ConcurrentStartsRejectTheLoser(t *testing.T) {
	s := lifecycleStore(t)
	callID := seedLiveCallForRecording(t, s)

	const attempts = 8 // wide enough that a race window shows up reliably
	results := make([]error, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := uuid.Must(uuid.NewV7()).String()
			egressID := "EG_" + uuid.Must(uuid.NewV7()).String() // distinct per attempt, like real LiveKit egresses
			results[i] = s.StartRecording(context.Background(), id, callID, egressID, "blobs/x/rec.mp4")
		}(i)
	}
	wg.Wait()

	var winners, losers int
	for _, err := range results {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrAlreadyRecording):
			losers++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if winners != 1 {
		t.Errorf("winners = %d, want exactly 1 — two concurrent starts must not both succeed", winners)
	}
	if losers != attempts-1 {
		t.Errorf("losers = %d, want %d, all as ErrAlreadyRecording", losers, attempts-1)
	}

	statuses := recordingStatusesForCall(t, s, callID)
	recording := 0
	for _, st := range statuses {
		if st == RecordingInProgress {
			recording++
		}
	}
	if recording != 1 {
		t.Errorf("RECORDING rows for this call = %d, want exactly 1 — got rows %v", recording, statuses)
	}
}

// ── Positive control: the SAME egress_id retried is still idempotent ─────────
func TestStartRecording_SameEgressIDIsIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	callID := seedLiveCallForRecording(t, s)
	egressID := "EG_" + uuid.Must(uuid.NewV7()).String()

	id1 := uuid.Must(uuid.NewV7()).String()
	if err := s.StartRecording(context.Background(), id1, callID, egressID, "blobs/x/rec.mp4"); err != nil {
		t.Fatalf("first start: %v", err)
	}
	// A retry of the SAME request (same egress_id) must not be treated as a
	// competing start — the fix must not regress the idempotency 0024 already
	// guaranteed.
	id2 := uuid.Must(uuid.NewV7()).String()
	if err := s.StartRecording(context.Background(), id2, callID, egressID, "blobs/x/rec.mp4"); err != nil {
		t.Errorf("retry with the same egress_id: %v, want nil (idempotent)", err)
	}

	statuses := recordingStatusesForCall(t, s, callID)
	if len(statuses) != 1 {
		t.Errorf("rows for this call = %d, want exactly 1 (the retry must not fork a second row)", len(statuses))
	}
}
