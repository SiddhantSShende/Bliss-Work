package store

// ListMyCallsInRange — the calendar read, against a real Postgres with RLS
// actually enforcing.
//
// ── Why this needs a database ────────────────────────────────────────────────
// The whole method IS a WHERE clause. Its two interesting properties — that a
// meeting spanning a boundary appears in BOTH windows, and that the window is
// half-open so one starting exactly on the boundary appears in exactly one —
// live in SQL that no Go-level test can exercise. The failure mode is also the
// quiet kind: a meeting missing from a week reads as a free afternoon, not as a
// bug.
//
// It runs under withCaller, so it is also the read path the participant RLS
// disjunct exists for — a policy regression here would empty a cross-org
// invitee's calendar, which again looks like an empty calendar.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's
// header for how to stand one up and why the role must not bypass RLS.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// rangeCall is one seeded meeting plus the person on its roster.
type rangeCall struct {
	id, orgID, member string
}

// seedRangeCall writes a call directly, bypassing the API: the fixture is not
// the code under test, and the endpoints that would create one all pin the
// times to now, which is exactly what these cases need to control.
func seedRangeCall(
	t *testing.T, s *Store, orgID, member string,
	status string, scheduledAt, endsAt, startedAt, endedAt *time.Time,
) rangeCall {
	t.Helper()
	c := rangeCall{id: uuid.Must(uuid.NewV7()).String(), orgID: orgID, member: member}
	ctx := context.Background()
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, created_by,
			                   scheduled_at, ends_at, started_at, ended_at, status)
			VALUES ($1, $2, 'MEETING', 'range test', $3, $4, $5, $6, $7, $8)`,
			c.id, orgID, member, scheduledAt, endsAt, startedAt, endedAt, status); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role)
			VALUES ($1, $2, $3, $4)`, c.id, member, orgID, RoleHost)
		return err
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, derr := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, c.id)
			return derr
		})
	})
	return c
}

func ptrTime(t time.Time) *time.Time { return &t }

func idsOf(calls []CallDTO) map[string]bool {
	out := make(map[string]bool, len(calls))
	for _, c := range calls {
		out[c.ID] = true
	}
	return out
}

// The window is half-open, [from, to). A meeting starting exactly at the
// boundary belongs to the NEXT window and to that one only — otherwise every
// midnight meeting is drawn twice, once at the bottom of one day and once at
// the top of the next.
func TestListMyCallsInRangeIsHalfOpen(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()

	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 7)

	onFrom := seedRangeCall(t, s, orgID, member, "SCHEDULED",
		ptrTime(from), ptrTime(from.Add(time.Hour)), nil, nil)
	onTo := seedRangeCall(t, s, orgID, member, "SCHEDULED",
		ptrTime(to), ptrTime(to.Add(time.Hour)), nil, nil)

	got, err := s.ListMyCallsInRange(ctx, orgID, member, from, to)
	if err != nil {
		t.Fatalf("ListMyCallsInRange: %v", err)
	}
	ids := idsOf(got)
	if !ids[onFrom.id] {
		t.Error("a meeting starting exactly at `from` is missing; the window must include it")
	}
	if ids[onTo.id] {
		t.Error("a meeting starting exactly at `to` was included; the window must exclude it")
	}
}

// Overlap, not containment. A meeting that began before the window and is still
// running inside it is ON this calendar — a week view that only asked "does it
// START here" would drop the Monday-morning half of a meeting that began on
// Sunday night.
func TestListMyCallsInRangeIncludesMeetingsSpanningTheBoundary(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()

	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 7)

	// Started ninety minutes before the window opened and ran an hour into it.
	spanning := seedRangeCall(t, s, orgID, member, "ENDED",
		ptrTime(from.Add(-90*time.Minute)), nil,
		ptrTime(from.Add(-90*time.Minute)), ptrTime(from.Add(time.Hour)))
	// Entirely before the window, and must not appear.
	before := seedRangeCall(t, s, orgID, member, "ENDED",
		ptrTime(from.Add(-5*time.Hour)), nil,
		ptrTime(from.Add(-5*time.Hour)), ptrTime(from.Add(-4*time.Hour)))

	got, err := s.ListMyCallsInRange(ctx, orgID, member, from, to)
	if err != nil {
		t.Fatalf("ListMyCallsInRange: %v", err)
	}
	ids := idsOf(got)
	if !ids[spanning.id] {
		t.Error("a meeting running across `from` is missing; the test is overlap, not containment")
	}
	if ids[before.id] {
		t.Error("a meeting that finished before the window was included")
	}
}

// Every status, and only this caller's meetings. A calendar shows what happened
// as well as what is coming — and a CANCELLED row is what tells somebody the
// thing they remember booking is not happening.
func TestListMyCallsInRangeCoversEveryStatusAndOnlyTheCallersOwn(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()
	stranger := uuid.Must(uuid.NewV7()).String()

	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 7)
	at := from.Add(36 * time.Hour)

	mine := map[string]rangeCall{}
	for _, status := range []string{"SCHEDULED", "LIVE", "ENDED", "CANCELLED"} {
		mine[status] = seedRangeCall(t, s, orgID, member, status,
			ptrTime(at), ptrTime(at.Add(time.Hour)), nil, nil)
	}
	// Same org, same window, somebody else's roster.
	theirs := seedRangeCall(t, s, orgID, stranger, "SCHEDULED",
		ptrTime(at), ptrTime(at.Add(time.Hour)), nil, nil)

	got, err := s.ListMyCallsInRange(ctx, orgID, member, from, to)
	if err != nil {
		t.Fatalf("ListMyCallsInRange: %v", err)
	}
	ids := idsOf(got)
	for status, c := range mine {
		if !ids[c.id] {
			t.Errorf("a %s meeting is missing from the calendar", status)
		}
	}
	if ids[theirs.id] {
		t.Error("a meeting the caller is not on the roster of was returned")
	}
}

// The end boundary must be exactly as strict as the start boundary. A meeting
// that ENDS exactly at a window's `from` (an 11pm-midnight meeting, most
// naturally) has nothing left inside that window — it belongs only to the
// PRIOR window, the one it is the closing edge of. Without a strict `>` on
// the end check, such a meeting was drawn in both: once in the week it
// actually happened, and again in the week that starts the instant it ends.
func TestListMyCallsInRangeExcludesACallEndingExactlyAtTheWindowStart(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()

	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 7)
	priorFrom := from.AddDate(0, 0, -7)

	// Ran from 11pm the night before straight up to midnight, exactly on `from`.
	endsAtFrom := seedRangeCall(t, s, orgID, member, "ENDED",
		ptrTime(from.Add(-time.Hour)), nil,
		ptrTime(from.Add(-time.Hour)), ptrTime(from))

	got, err := s.ListMyCallsInRange(ctx, orgID, member, from, to)
	if err != nil {
		t.Fatalf("ListMyCallsInRange (the window it ends on): %v", err)
	}
	if idsOf(got)[endsAtFrom.id] {
		t.Error("a meeting ending exactly at `from` was included in the window it does not overlap")
	}

	gotPrior, err := s.ListMyCallsInRange(ctx, orgID, member, priorFrom, from)
	if err != nil {
		t.Fatalf("ListMyCallsInRange (the window it actually ran in): %v", err)
	}
	if !idsOf(gotPrior)[endsAtFrom.id] {
		t.Error("a meeting ending exactly at `from` is missing from the window that actually contains it")
	}
}

// A window that is empty, inverted, or absurdly wide must not be a way to ask
// for the whole table. The inverted case answers nothing; the wide one is
// clamped to the ceiling rather than run as asked.
func TestListMyCallsInRangeRefusesAnInvertedWindowAndClampsAWideOne(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()

	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	inWindow := seedRangeCall(t, s, orgID, member, "SCHEDULED",
		ptrTime(from.Add(time.Hour)), ptrTime(from.Add(2*time.Hour)), nil, nil)
	// Beyond the clamp, so a request for "ten years" must not reach it.
	farFuture := from.AddDate(0, 0, MaxCallRangeDays+30)
	beyond := seedRangeCall(t, s, orgID, member, "SCHEDULED",
		ptrTime(farFuture), ptrTime(farFuture.Add(time.Hour)), nil, nil)

	empty, err := s.ListMyCallsInRange(ctx, orgID, member, from, from.Add(-time.Hour))
	if err != nil {
		t.Fatalf("inverted window: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("an inverted window returned %d calls, want none", len(empty))
	}

	wide, err := s.ListMyCallsInRange(ctx, orgID, member, from, from.AddDate(10, 0, 0))
	if err != nil {
		t.Fatalf("wide window: %v", err)
	}
	ids := idsOf(wide)
	if !ids[inWindow.id] {
		t.Error("the clamped window dropped a meeting inside the ceiling")
	}
	if ids[beyond.id] {
		t.Error("a meeting beyond MaxCallRangeDays was returned; the window was not clamped")
	}
}
