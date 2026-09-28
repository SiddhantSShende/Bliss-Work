package store

// Creating a repeating meeting and keeping it topped up. See
// meeting_series_helpers_db_test.go for how to run these.

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// The feature request's own example, end to end through a real database: a
// weekly meeting on Monday, Wednesday and Friday. It must write ONLY what falls
// inside the horizon — a handful of rows, not a series' whole lifetime — and every
// row must be a real meeting at the right wall-clock time.
func TestMeetingSeries_WeeklyMonWedFriWritesOnlyTheHorizon(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	berlin := mustLoc(t, "Europe/Berlin")
	start := nextLocal(berlin, time.Monday, 10)
	rule := weeklyRule(1, 0, 2, 4)

	first := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "Europe/Berlin"}.schedule(t, s)

	if first.Series == nil {
		t.Fatal("the first occurrence carries no series summary")
	}
	if first.Series.Recurrence.Frequency != "WEEKLY" || first.Series.Recurrence.Interval != 1 ||
		len(first.Series.Recurrence.Weekdays) != 3 || first.Series.Recurrence.TimeZone != "Europe/Berlin" ||
		first.Series.Recurrence.EndCondition != "NO_END" {
		t.Errorf("recurrence = %+v", first.Series.Recurrence)
	}
	if first.ScheduledAt == nil || *first.ScheduledAt != start.UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("first occurrence at %v, want the requested start %v", first.ScheduledAt, start.UTC())
	}

	horizon := time.Now().UTC().Add(SeriesHorizon)
	got := occurrencesOf(t, s, first.Series.ID)
	want := expectedInHorizon(t, rule, start, "Europe/Berlin", horizon)
	if len(got) != len(want) {
		t.Fatalf("wrote %d occurrences, the schedule says %d", len(got), len(want))
	}
	if len(got) < 12 || len(got) > 20 {
		t.Errorf("%d occurrences for six weeks of Mon/Wed/Fri — not a plausible horizon", len(got))
	}
	for i, o := range got {
		if !o.at.Equal(want[i]) {
			t.Errorf("occurrence %d at %v, want %v", i, o.at, want[i])
		}
		local := o.at.In(berlin)
		if wd := local.Weekday(); wd != time.Monday && wd != time.Wednesday && wd != time.Friday {
			t.Errorf("occurrence %d is on a %s", i, wd)
		}
		if local.Hour() != 10 || local.Minute() != 0 {
			t.Errorf("occurrence %d at %s local, want 10:00", i, local.Format("15:04"))
		}
		if o.status != CallScheduled {
			t.Errorf("occurrence %d is %s, want SCHEDULED", i, o.status)
		}
		if i > 0 && !o.at.After(got[i-1].at) {
			t.Errorf("occurrence %d is not after the one before it", i)
		}
	}

	// The cursor points at the first occurrence NOT written, beyond the horizon.
	series, err := s.GetSeries(context.Background(), org, host, first.Series.ID)
	if err != nil {
		t.Fatalf("GetSeries: %v", err)
	}
	if series.NextStartAt == nil {
		t.Fatal("a never-ending series has no next occurrence")
	}
	next, _ := time.Parse(time.RFC3339, *series.NextStartAt)
	if !next.After(horizon.Add(-time.Minute)) {
		t.Errorf("next unwritten occurrence %v is inside the horizon %v", next, horizon)
	}
	if series.OccurrenceCount != len(got) {
		t.Errorf("occurrenceCount = %d, rows = %d", series.OccurrenceCount, len(got))
	}
	if series.Status != SeriesActive {
		t.Errorf("status = %s", series.Status)
	}
}

// Every field of the recurrence survives a round trip through the database:
// what an edit form reads back is what was sent.
func TestMeetingSeries_EveryRecurrenceFieldIsPersisted(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	tokyo := mustLoc(t, "Asia/Tokyo")
	start := nextLocal(tokyo, time.Tuesday, 9)

	end := start.AddDate(0, 3, 0).Format("2006-01-02")
	rule := recurrence.Rule{Frequency: recurrence.Weekly, Interval: 2, Weekdays: []int{3, 1},
		EndCondition: recurrence.EndOnDate, EndDate: end}
	c := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "Asia/Tokyo"}.schedule(t, s)

	got, err := s.GetSeries(context.Background(), org, host, c.Series.ID)
	if err != nil {
		t.Fatalf("GetSeries: %v", err)
	}
	r := got.Recurrence
	if r.Frequency != "WEEKLY" || r.Interval != 2 || r.EndCondition != "ON_DATE" ||
		r.EndDate == nil || *r.EndDate != end || r.TimeZone != "Asia/Tokyo" {
		t.Errorf("recurrence = %+v", r)
	}
	if len(r.Weekdays) != 2 || r.Weekdays[0] != 1 || r.Weekdays[1] != 3 {
		t.Errorf("weekdays = %v, want [1 3] (stored sorted)", r.Weekdays)
	}
	if got.Title != "Team sync" || got.Media != "video" || got.DurationMinutes != 60 || got.CreatedBy != host {
		t.Errorf("series = %+v", got)
	}
	if !equalInstants(t, got.StartAt, start) {
		t.Errorf("startAt = %s, want %s", got.StartAt, start.UTC())
	}
}

func equalInstants(t *testing.T, iso string, want time.Time) bool {
	t.Helper()
	got, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		t.Fatalf("parse %q: %v", iso, err)
	}
	return got.Equal(want.Truncate(time.Millisecond))
}

// Every end condition, through the database. The end is counted, and dated, on
// the organiser's wall.
func TestMeetingSeries_EndConditions(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	utc := time.UTC
	start := nextLocal(utc, time.Monday, 8)

	t.Run("after N occurrences writes exactly N and completes the series", func(t *testing.T) {
		rule := weeklyRule(1, 0, 2, 4)
		rule.EndCondition, rule.OccurrenceCount = recurrence.EndAfterCount, 5
		c := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}.schedule(t, s)
		if n := len(occurrencesOf(t, s, c.Series.ID)); n != 5 {
			t.Fatalf("wrote %d occurrences, want 5", n)
		}
		got, _ := s.GetSeries(context.Background(), org, host, c.Series.ID)
		if got.Status != SeriesCompleted || got.NextStartAt != nil {
			t.Errorf("status = %s, next = %v; a finished series has neither", got.Status, got.NextStartAt)
		}
	})

	t.Run("on a date stops at that day, inclusive", func(t *testing.T) {
		endDay := start.AddDate(0, 0, 9) // a Wednesday two weeks in
		rule := weeklyRule(1, 0, 2, 4)
		rule.EndCondition, rule.EndDate = recurrence.EndOnDate, endDay.Format("2006-01-02")
		c := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}.schedule(t, s)
		got := occurrencesOf(t, s, c.Series.ID)
		if len(got) == 0 {
			t.Fatal("wrote nothing")
		}
		last := got[len(got)-1].at
		if last.Format("2006-01-02") > endDay.Format("2006-01-02") {
			t.Errorf("last occurrence %v is after the end date %v", last, endDay)
		}
		if last.Weekday() != time.Wednesday || last.Format("2006-01-02") != endDay.Format("2006-01-02") {
			t.Errorf("last occurrence %v, want the end date itself (%v) to be kept", last, endDay)
		}
	})

	t.Run("a series that has finished is not topped up again", func(t *testing.T) {
		rule := dailyRule()
		rule.EndCondition, rule.OccurrenceCount = recurrence.EndAfterCount, 2
		c := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}.schedule(t, s)
		before := len(occurrencesOf(t, s, c.Series.ID))
		if _, err := s.TopUpDueSeries(context.Background(), 1000); err != nil {
			t.Fatalf("TopUpDueSeries: %v", err)
		}
		if after := len(occurrencesOf(t, s, c.Series.ID)); after != before || before != 2 {
			t.Errorf("rows %d -> %d, want a stable 2", before, after)
		}
	})
}

// Every second week on Tuesday and Thursday — the request's second example.
func TestMeetingSeries_EveryTwoWeeksTuesdayThursday(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	start := nextLocal(time.UTC, time.Tuesday, 15)
	rule := weeklyRule(2, 1, 3)

	c := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}.schedule(t, s)
	got := occurrencesOf(t, s, c.Series.ID)
	if len(got) < 4 {
		t.Fatalf("only %d occurrences", len(got))
	}
	// Pairs: Tue, Thu, then a fortnight later.
	for i := 0; i+2 < len(got); i += 2 {
		if got[i].at.Weekday() != time.Tuesday || got[i+1].at.Weekday() != time.Thursday {
			t.Fatalf("occurrences %d/%d are %s/%s, want Tue/Thu", i, i+1, got[i].at.Weekday(), got[i+1].at.Weekday())
		}
		if gap := got[i+2].at.Sub(got[i].at); gap != 14*24*time.Hour {
			t.Errorf("gap between the Tuesdays is %v, want 14 days", gap)
		}
	}
}

// Time passing: the sweeper writes what has come inside the horizon, exactly
// once, however many replicas run it at the same moment.
func TestMeetingSeries_TopUpWritesTheRestOnceEvenWhenRacing(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	start := nextLocal(time.UTC, time.Monday, 8)
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}.schedule(t, s)
	full := len(occurrencesOf(t, s, c.Series.ID))

	// Wind the series back to "only the first ten have been written", which is
	// where it would be ten days into the past of its own horizon.
	rows := occurrencesOf(t, s, c.Series.ID)
	cut := rows[10]
	bypassExec(t, s, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, c.Series.ID, cut.at)
	bypassExec(t, s, `UPDATE call_series SET occurrence_count = 10, next_start_at = $2 WHERE id = $1`,
		c.Series.ID, cut.at)

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.TopUpDueSeries(ctx, 100)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("a racing sweeper failed: %v", err)
		}
	}

	if after := len(occurrencesOf(t, s, c.Series.ID)); after != full {
		t.Fatalf("after eight racing sweeps there are %d occurrences, want exactly %d", after, full)
	}
	if n, err := s.TopUpDueSeries(ctx, 100); err != nil || n != 0 {
		t.Errorf("a further sweep advanced %d series (err %v), want none", n, err)
	}
}

// The database itself refuses to hold two occurrences at one instant, so a
// double write can never double-book people even if a code path were wrong.
func TestMeetingSeries_TheDatabaseRefusesADuplicateOccurrence(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)
	first := occurrencesOf(t, s, c.Series.ID)[0]

	err := bypassExecErr(s, `
		INSERT INTO calls (id, org_id, kind, created_by, scheduled_at, status, series_id)
		VALUES (gen_random_uuid(), $1, 'MEETING', $2, $3, 'SCHEDULED', $4)`,
		org, host, first.at, c.Series.ID)
	if err == nil {
		t.Fatal("a second occurrence at the same instant was accepted")
	}
}

// A repeating meeting needs a start; "meet now" has nothing to repeat from.
func TestMeetingSeries_RequiresAStartTime(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	_, err := s.ScheduleMeetingWithOptions(context.Background(), org, host, "x", "video",
		nil, nil, nil, MeetingOptions{Recurrence: &RecurrenceInput{Rule: rule, TimeZone: "UTC"}})
	if !errors.Is(err, recurrence.ErrInvalid) {
		t.Fatalf("err = %v, want recurrence.ErrInvalid", err)
	}
}

// A rule the engine refuses is refused before anything is written.
func TestMeetingSeries_AnInvalidRuleWritesNothing(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := weeklyRule(1) // no weekday
	_, err := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8),
		rule: &rule, zone: "UTC"}.tryScheduling(s)
	if !errors.Is(err, recurrence.ErrInvalid) {
		t.Fatalf("err = %v, want recurrence.ErrInvalid", err)
	}
	if n := bypassCount(t, s, `SELECT count(*) FROM calls WHERE org_id = $1`, org); n != 0 {
		t.Errorf("%d calls were written for a refused request", n)
	}
	if n := bypassCount(t, s, `SELECT count(*) FROM call_series WHERE org_id = $1`, org); n != 0 {
		t.Errorf("%d series were written for a refused request", n)
	}
}

// The Upcoming list keeps the FURTHEST meetings when it overflows its page, so a
// repeating meeting written six weeks ahead must not push nearer meetings off it.
// Only its next few occurrences are listed; the calendar's own read has them all.
func TestMeetingSeries_ListMyCallsCapsAndDoesNotCrowdOutNearerMeetings(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	series := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)
	total := len(occurrencesOf(t, s, series.Series.ID))
	if total <= SeriesUpcomingInList {
		t.Fatalf("fixture: only %d occurrences", total)
	}
	// A one-off scheduled BEFORE the series' last occurrences but after its first.
	oneOffAt := time.Now().UTC().Add(30 * time.Hour)
	oneOff := meetingIn{orgID: org, host: host, start: oneOffAt}.schedule(t, s)

	listed, err := s.ListMyCalls(ctx, org, host, 100)
	if err != nil {
		t.Fatalf("ListMyCalls: %v", err)
	}
	inSeries := 0
	sawOneOff := false
	for _, c := range listed {
		if c.Series != nil && c.Series.ID == series.Series.ID {
			inSeries++
		}
		if c.ID == oneOff.ID {
			sawOneOff = true
		}
	}
	if inSeries != SeriesUpcomingInList {
		t.Errorf("list carries %d occurrences of the series, want %d", inSeries, SeriesUpcomingInList)
	}
	if !sawOneOff {
		t.Error("the one-off meeting was crowded out of the list")
	}

	// The calendar read is not capped this way: it returns every one in its window.
	from, to := time.Now().UTC(), time.Now().UTC().Add(SeriesHorizon+48*time.Hour)
	ranged, err := s.ListMyCallsInRange(ctx, org, host, from, to)
	if err != nil {
		t.Fatalf("ListMyCallsInRange: %v", err)
	}
	inRange := 0
	for _, c := range ranged {
		if c.Series != nil && c.Series.ID == series.Series.ID {
			inRange++
		}
	}
	if inRange != total {
		t.Errorf("the calendar window holds %d occurrences, want all %d", inRange, total)
	}
}
