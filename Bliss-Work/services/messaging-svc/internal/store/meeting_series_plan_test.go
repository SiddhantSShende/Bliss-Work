package store

import (
	"testing"
	"time"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// planOccurrences is pure, so its rules are checked without a database.

func planSched(t *testing.T, r recurrence.Rule, start string) (recurrence.Schedule, time.Time) {
	t.Helper()
	at, err := time.Parse("2006-01-02 15:04", start)
	if err != nil {
		t.Fatal(err)
	}
	s, err := recurrence.New(r, at, "UTC")
	if err != nil {
		t.Fatalf("recurrence.New: %v", err)
	}
	first, _ := s.After(s.Anchor.Add(-time.Nanosecond))
	return s, first
}

func day(s string) time.Time {
	t, _ := time.Parse("2006-01-02 15:04", s)
	return t
}

func TestPlanStopsAtTheHorizon(t *testing.T) {
	s, first := planSched(t, dailyRule(), "2026-10-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2026-10-05 23:59"), Limit: 100})
	if len(planned) != 5 {
		t.Fatalf("planned %d, want 5 (1st..5th)", len(planned))
	}
	if next == nil || next.Format("2006-01-02") != "2026-10-06" {
		t.Errorf("cursor = %v, want the 6th", next)
	}
}

// A series that starts beyond the horizon still gets its first occurrence.
func TestPlanAlwaysWritesTheFirstEvenPastTheHorizon(t *testing.T) {
	s, first := planSched(t, dailyRule(), "2027-03-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2026-10-05 00:00"), Limit: 100, AtLeastOne: true})
	if len(planned) != 1 || planned[0].Format("2006-01-02") != "2027-03-01" {
		t.Fatalf("planned %v", planned)
	}
	if next == nil || next.Format("2006-01-02") != "2027-03-02" {
		t.Errorf("cursor = %v", next)
	}
}

// A top-up never writes past the horizon — even when the cursor has been moved past
// everything that exists and now lies beyond it.
func TestPlanWithoutAtLeastOneWritesNothingBeyondTheHorizon(t *testing.T) {
	s, first := planSched(t, dailyRule(), "2027-03-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2026-10-05 00:00"), Limit: 100})
	if len(planned) != 0 || next == nil || next.Format("2006-01-02") != "2027-03-01" {
		t.Fatalf("planned %v, cursor %v; want nothing planned and the cursor left where it is", planned, next)
	}
}

func TestPlanRespectsTheBatchLimit(t *testing.T) {
	s, first := planSched(t, dailyRule(), "2026-10-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2027-10-01 00:00"), Limit: 7})
	if len(planned) != 7 || next.Format("2006-01-02") != "2026-10-08" {
		t.Fatalf("planned %d, cursor %v", len(planned), next)
	}
}

// "After N" counts occurrences that already exist, and finishing leaves no cursor.
func TestPlanCountsWhatAlreadyExistsTowardTheEnd(t *testing.T) {
	r := dailyRule()
	r.EndCondition, r.OccurrenceCount = recurrence.EndAfterCount, 6
	s, first := planSched(t, r, "2026-10-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Produced: 4, Horizon: day("2027-01-01 00:00"), Limit: 100})
	if len(planned) != 2 {
		t.Fatalf("planned %d, want the 2 that remain of 6", len(planned))
	}
	if next != nil {
		t.Errorf("cursor = %v, want none: the series is finished", next)
	}
}

func TestPlanEndDateIsInclusive(t *testing.T) {
	r := dailyRule()
	r.EndCondition, r.EndDate = recurrence.EndOnDate, "2026-10-03"
	s, first := planSched(t, r, "2026-10-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2027-01-01 00:00"), Limit: 100})
	if len(planned) != 3 || next != nil {
		t.Fatalf("planned %d, cursor %v", len(planned), next)
	}
}

// Instants that already exist are stepped over: not planned again (the unique index
// would refuse them) and not counted again (the caller already counts them).
func TestPlanStepsOverWhatAlreadyExists(t *testing.T) {
	s, first := planSched(t, dailyRule(), "2026-10-01 09:00")
	exists := map[int64]bool{day("2026-10-02 09:00").Unix(): true, day("2026-10-04 09:00").Unix(): true}
	planned, _ := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2026-10-06 23:00"), Limit: 100, Exists: exists})
	var got []string
	for _, p := range planned {
		got = append(got, p.Format("02"))
	}
	if len(got) != 4 || got[0] != "01" || got[1] != "03" || got[2] != "05" || got[3] != "06" {
		t.Fatalf("planned days %v, want 01 03 05 06", got)
	}
	// A cursor that lands on an existing instant is moved past it.
	planned, next := planOccurrences(occurrencePlan{Sched: s, Start: &first, Horizon: day("2026-10-01 23:00"), Limit: 100, Exists: map[int64]bool{day("2026-10-02 09:00").Unix(): true}})
	if len(planned) != 1 || next == nil || next.Format("02") != "03" {
		t.Errorf("planned %v, cursor %v; the cursor must skip the existing 2nd", planned, next)
	}
}

// A series that was paused resumes from now and does not write what it missed — and
// what it missed is not counted against an "after N" end either.
func TestPlanNotBeforeSkipsMissedInstantsWithoutCountingThem(t *testing.T) {
	r := dailyRule()
	r.EndCondition, r.OccurrenceCount = recurrence.EndAfterCount, 3
	s, first := planSched(t, r, "2026-10-01 09:00")
	planned, next := planOccurrences(occurrencePlan{
		Sched: s, Start: &first, Horizon: day("2027-01-01 00:00"), Limit: 100, NotBefore: day("2026-10-10 00:00"),
	})
	if len(planned) != 3 || planned[0].Format("2006-01-02") != "2026-10-10" {
		t.Fatalf("planned %v, want three meetings starting 10 Oct", planned)
	}
	if next != nil {
		t.Errorf("cursor = %v after the third", next)
	}
}

func TestPlanWithNothingToStartFromPlansNothing(t *testing.T) {
	s, _ := planSched(t, dailyRule(), "2026-10-01 09:00")
	planned, next := planOccurrences(occurrencePlan{Sched: s, Horizon: day("2027-01-01 00:00"), Limit: 10})
	if len(planned) != 0 || next != nil {
		t.Errorf("planned %v, cursor %v", planned, next)
	}
}
