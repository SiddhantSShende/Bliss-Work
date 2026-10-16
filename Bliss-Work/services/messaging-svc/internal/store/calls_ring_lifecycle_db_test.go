package store

// The ring-timeout and decline lifecycle — unifying the one-to-one calling UI
// with the meeting room means direct calls now ring, time out and get
// declined through the SAME server-authoritative state every other call
// lifecycle transition uses, against a real Postgres with RLS enforcing. See
// calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL).
//
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run 'TestRing|TestDecline' -v

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// expireRingNow backdates callID's ring deadline for userID into the past, so
// ExpireRingingInvitations claims it on the next sweep instead of a test
// waiting out DirectRingTimeout/AdditionalInviteRingTimeout for real.
func expireRingNow(t *testing.T, s *Store, callID, userID string) {
	t.Helper()
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			UPDATE call_participants SET ring_expires_at = now() - interval '1 second'
			WHERE call_id = $1 AND user_id = $2`, callID, userID)
		return err
	}); err != nil {
		t.Fatalf("expire ring: %v", err)
	}
}

func ringExpiresAtOf(t *testing.T, s *Store, callID, userID string) *time.Time {
	t.Helper()
	var ts *time.Time
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT ring_expires_at FROM call_participants
			WHERE call_id = $1 AND user_id = $2`, callID, userID).Scan(&ts)
	}); err != nil {
		t.Fatalf("read ring_expires_at: %v", err)
	}
	return ts
}

func assertRingTimeout(
	t *testing.T, s *Store, callID, userID string, timeout time.Duration, started, completed time.Time,
) {
	t.Helper()
	expires := ringExpiresAtOf(t, s, callID, userID)
	if expires == nil {
		t.Fatalf("ring_expires_at for %s was not set", userID)
	}
	if earliest, latest := started.Add(timeout), completed.Add(timeout); expires.Before(earliest) || expires.After(latest) {
		t.Errorf("ring_expires_at = %s, want between %s and %s (%s timeout)", expires, earliest, latest, timeout)
	}
}

func missedAtOf(t *testing.T, s *Store, callID, userID string) *time.Time {
	t.Helper()
	var ts *time.Time
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT missed_at FROM call_participants
			WHERE call_id = $1 AND user_id = $2`, callID, userID).Scan(&ts)
	}); err != nil {
		t.Fatalf("read missed_at: %v", err)
	}
	return ts
}

// forCall picks out the one expired ring belonging to callID from a sweep's
// results. The sweep is intentionally global (every org, every call — see
// ExpireRingingInvitations' own doc comment), so in a shared test database a
// single sweep call made deep into a long test run can ALSO resolve
// unrelated rings left ready to expire by other tests that ran first — this
// is what makes that safe to ignore rather than a flaky len(expired) assert.
func forCall(t *testing.T, expired []ExpiredRing, callID string) ExpiredRing {
	t.Helper()
	for _, r := range expired {
		if r.CallID == callID {
			return r
		}
	}
	t.Fatalf("no expired ring for call %s among %d result(s)", callID, len(expired))
	return ExpiredRing{}
}

func callStatusOf(t *testing.T, s *Store, callID string) string {
	t.Helper()
	var status string
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT status FROM calls WHERE id = $1`, callID).Scan(&status)
	}); err != nil {
		t.Fatalf("read call status: %v", err)
	}
	return status
}

func TestRingDeadlinesAreSetOnCreateAndNeverOnTheHost(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 4)
	a, b, c, d := u[0], u[1], u[2], u[3]

	started := time.Now().UTC()
	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	completed := time.Now().UTC()
	assertRingTimeout(t, s, call.ID, b, DirectRingTimeout, started, completed)
	if ts := ringExpiresAtOf(t, s, call.ID, a); ts != nil {
		t.Fatal("the HOST's own row must not carry a ring deadline")
	}

	// AddParticipant into an already-live call rings the newcomer too.
	started = time.Now().UTC()
	if err := s.AddParticipant(ctx, org, a, call.ID, c); err != nil {
		t.Fatalf("add %s: %v", c, err)
	}
	completed = time.Now().UTC()
	assertRingTimeout(t, s, call.ID, c, AdditionalInviteRingTimeout, started, completed)

	// A multi-select "Call" rings every peer in the roster it creates.
	started = time.Now().UTC()
	conf, err := s.CreateConferenceCall(ctx, org, a, []string{b, d}, "", "video")
	if err != nil {
		t.Fatalf("conference: %v", err)
	}
	completed = time.Now().UTC()
	for _, peer := range []string{b, d} {
		assertRingTimeout(t, s, conf.ID, peer, DirectRingTimeout, started, completed)
	}
	if ts := ringExpiresAtOf(t, s, conf.ID, a); ts != nil {
		t.Fatal("the conference HOST's own row must not carry a ring deadline")
	}
}

func TestExpireRingingInvitations_UnansweredOneToOneEndsTheCall(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 2)
	a, b := u[0], u[1]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a) // the caller enters the unified room immediately
	expireRingNow(t, s, call.ID, b)

	expired, err := s.ExpireRingingInvitations(ctx, 0)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	got := forCall(t, expired, call.ID)
	if got.InviterID != a || got.InviteeID != b {
		t.Fatalf("expired ring = %+v, want inviter=%s invitee=%s", got, a, b)
	}
	if got.Ended == nil || got.Ended.Status != CallEnded {
		t.Fatalf("Ended = %+v, want the call reported ended", got.Ended)
	}
	if callStatusOf(t, s, call.ID) != CallEnded {
		t.Fatal("the call itself was not actually ended")
	}
	if ts := missedAtOf(t, s, call.ID, b); ts == nil {
		t.Fatal("the invitee's missed_at was never set")
	}

	// A second sweep claims nothing MORE for this call: already resolved.
	again, err := s.ExpireRingingInvitations(ctx, 0)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	for _, r := range again {
		if r.CallID == call.ID {
			t.Fatalf("second sweep re-resolved this call: %+v", r)
		}
	}
}

func TestExpireRingingInvitations_ThirdPersonTimeoutLeavesTheCallRunning(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	a, b, c := u[0], u[1], u[2]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a, b) // both original participants are actually in it
	if err := s.AddParticipant(ctx, org, b, call.ID, c); err != nil {
		t.Fatalf("add %s: %v", c, err)
	}
	expireRingNow(t, s, call.ID, c)

	expired, err := s.ExpireRingingInvitations(ctx, 0)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	got := forCall(t, expired, call.ID)
	if got.InviterID != b || got.InviteeID != c {
		t.Fatalf("expired ring = %+v, want inviter=%s invitee=%s", got, b, c)
	}
	if got.Ended != nil {
		t.Fatalf("the call ended, but A and B are still in it: %+v", got.Ended)
	}
	if callStatusOf(t, s, call.ID) != CallLive {
		t.Fatal("the call must still be LIVE for A and B")
	}
	if ts := missedAtOf(t, s, call.ID, c); ts == nil {
		t.Fatal("C's missed_at was never set")
	}
	// A and B's own rows are untouched.
	for _, who := range []string{a, b} {
		if ts := missedAtOf(t, s, call.ID, who); ts != nil {
			t.Fatalf("%s was marked missed too", who)
		}
	}
}

func TestExpireRingingInvitations_AnAnsweredRingIsNeverSwept(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 2)
	a, b := u[0], u[1]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a, b) // B answers before the deadline
	expireRingNow(t, s, call.ID, b)

	expired, err := s.ExpireRingingInvitations(ctx, 0)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	for _, r := range expired {
		if r.CallID == call.ID {
			t.Fatalf("B already joined, but the sweep resolved this call anyway: %+v", r)
		}
	}
	if callStatusOf(t, s, call.ID) != CallLive {
		t.Fatal("an answered call must not be ended")
	}
}

// TestLateJoinAfterTheSweepHasAlreadyMarkedItMissedIsRejected is the other
// half of the race ExpireRingingInvitations' own doc comment describes: an
// answer that arrives for a ring the sweep has ALREADY resolved — rather
// than one still racing it — must still be refused, not silently accepted
// into a call that may no longer exist.
func TestLateJoinAfterTheSweepHasAlreadyMarkedItMissedIsRejected(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	a, b, c := u[0], u[1], u[2]

	// The group-call shape, so the call survives the expiry and a late
	// ClaimCallSession has something other than ErrCallEnded to be refused
	// by — isolating the missed_at guard from the ordinary "call is over"
	// guard it sits alongside.
	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a, b)
	if err := s.AddParticipant(ctx, org, b, call.ID, c); err != nil {
		t.Fatalf("add %s: %v", c, err)
	}
	expireRingNow(t, s, call.ID, c)
	if _, err := s.ExpireRingingInvitations(ctx, 0); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	if err := s.ClaimCallSession(ctx, org, c, call.ID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("late join after missed = %v, want ErrForbidden", err)
	}
	row := getParticipantRow(t, s, call.ID, c)
	if row.joinedAt != nil {
		t.Fatal("the late join must not have stamped attendance")
	}
}

func TestDeclineCall_TheOnlyRingEndsTheCall(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 2)
	a, b := u[0], u[1]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a)

	inviter, ended, err := s.DeclineCall(ctx, org, b, call.ID)
	if err != nil {
		t.Fatalf("decline: %v", err)
	}
	if inviter != a {
		t.Fatalf("inviter = %q, want %q", inviter, a)
	}
	if ended == nil || ended.Status != CallEnded {
		t.Fatalf("ended = %+v, want the call ended", ended)
	}
	if ts := ringExpiresAtOf(t, s, call.ID, b); ts != nil {
		t.Fatal("a declined ring must not still carry a deadline")
	}

	// Idempotent: declining again finds nothing left to decline.
	inviter2, ended2, err := s.DeclineCall(ctx, org, b, call.ID)
	if err != nil {
		t.Fatalf("second decline: %v", err)
	}
	if inviter2 != "" || ended2 != nil {
		t.Fatalf("second decline = (%q, %+v), want a no-op", inviter2, ended2)
	}
}

func TestDeclineCall_ThirdPersonDeclineLeavesTheCallRunning(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	a, b, c := u[0], u[1], u[2]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a, b)
	if err := s.AddParticipant(ctx, org, b, call.ID, c); err != nil {
		t.Fatalf("add %s: %v", c, err)
	}

	inviter, ended, err := s.DeclineCall(ctx, org, c, call.ID)
	if err != nil {
		t.Fatalf("decline: %v", err)
	}
	if inviter != b {
		t.Fatalf("inviter = %q, want %q", inviter, b)
	}
	if ended != nil {
		t.Fatalf("the call ended, but A and B are still in it: %+v", ended)
	}
	if callStatusOf(t, s, call.ID) != CallLive {
		t.Fatal("the call must still be LIVE for A and B")
	}
}

func TestDeclineCall_CannotDeclineAfterJoining(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 2)
	a, b := u[0], u[1]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	join(t, s, org, call.ID, a, b)

	inviter, ended, err := s.DeclineCall(ctx, org, b, call.ID)
	if err != nil {
		t.Fatalf("decline: %v", err)
	}
	if inviter != "" || ended != nil {
		t.Fatalf("decline after joining = (%q, %+v), want a no-op", inviter, ended)
	}
	row := getParticipantRow(t, s, call.ID, b)
	if row.joinedAt == nil {
		t.Fatal("joining must not have been undone by the decline attempt")
	}
}
