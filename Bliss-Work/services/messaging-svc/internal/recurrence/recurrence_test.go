package recurrence

import (
	"errors"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"
)

// occurrences enumerates a schedule the way the store does: the first at or
// after the anchor, then each one strictly after the previous, stopping when the
// end condition refuses the next.
func occurrences(s Schedule, n int) []time.Time {
	var out []time.Time
	cur, ok := s.After(s.Anchor.Add(-time.Nanosecond))
	for ok && len(out) < n && s.Allows(cur, len(out)) {
		out = append(out, cur)
		cur, ok = s.After(cur)
	}
	return out
}

// wall renders instants as the organiser reads them: weekday, date, clock.
func wall(loc *time.Location, ts []time.Time) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.In(loc).Format("Mon 2006-01-02 15:04")
	}
	return out
}

func mustSchedule(t *testing.T, r Rule, start, zone string) Schedule {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatalf("zone %s: %v", zone, err)
	}
	at, err := time.ParseInLocation("2006-01-02 15:04", start, loc)
	if err != nil {
		t.Fatalf("start %q: %v", start, err)
	}
	s, err := New(r, at, zone)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func weekly(interval int, days ...int) Rule {
	return Rule{Frequency: Weekly, Interval: interval, Weekdays: days, EndCondition: EndNever}
}

const (
	mon, tue, wed, thu, fri, sat, sun = 0, 1, 2, 3, 4, 5, 6
)

// The example from the feature request, verbatim: start on a Monday, every week,
// Monday + Wednesday + Friday.
func TestWeeklyMondayWednesdayFriday(t *testing.T) {
	s := mustSchedule(t, weekly(1, mon, wed, fri), "2026-10-05 10:00", "Europe/Berlin")
	got := wall(s.Loc, occurrences(s, 7))
	want := []string{
		"Mon 2026-10-05 10:00", "Wed 2026-10-07 10:00", "Fri 2026-10-09 10:00",
		"Mon 2026-10-12 10:00", "Wed 2026-10-14 10:00", "Fri 2026-10-16 10:00",
		"Mon 2026-10-19 10:00",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

// The second example: every 2 weeks on Tuesday + Thursday. The week between is
// skipped entirely, and a start BEFORE the first chosen weekday (a Monday) lands
// on that week's Tuesday rather than a week late.
func TestEveryTwoWeeksTuesdayThursday(t *testing.T) {
	want := []string{
		"Tue 2026-10-06 09:30", "Thu 2026-10-08 09:30",
		"Tue 2026-10-20 09:30", "Thu 2026-10-22 09:30",
		"Tue 2026-11-03 09:30", "Thu 2026-11-05 09:30",
	}
	for _, start := range []string{"2026-10-06 09:30", "2026-10-05 09:30"} {
		s := mustSchedule(t, weekly(2, tue, thu), start, "UTC")
		got := wall(s.Loc, occurrences(s, 6))
		if !reflect.DeepEqual(got, want) {
			t.Errorf("start %s:\ngot  %v\nwant %v", start, got, want)
		}
	}
}

// Deselecting the start's own weekday is allowed: the series begins on the first
// day that matches, not on the day it was created.
func TestFirstOccurrenceIsTheFirstMatchingDay(t *testing.T) {
	s := mustSchedule(t, weekly(1, fri), "2026-10-05 10:00", "UTC") // a Monday
	got := wall(s.Loc, occurrences(s, 2))
	want := []string{"Fri 2026-10-09 10:00", "Fri 2026-10-16 10:00"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Month and year boundaries: a weekly Friday series walks over Dec 31 -> Jan 1.
func TestWeeklyAcrossTheYearBoundary(t *testing.T) {
	s := mustSchedule(t, weekly(1, fri, sun), "2026-12-25 08:00", "UTC")
	got := wall(s.Loc, occurrences(s, 5))
	want := []string{
		"Fri 2026-12-25 08:00", "Sun 2026-12-27 08:00",
		"Fri 2027-01-01 08:00", "Sun 2027-01-03 08:00", "Fri 2027-01-08 08:00",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestDailyEveryThreeDays(t *testing.T) {
	r := Rule{Frequency: Daily, Interval: 3, EndCondition: EndNever}
	s := mustSchedule(t, r, "2026-02-26 17:45", "UTC")
	got := wall(s.Loc, occurrences(s, 4))
	want := []string{
		"Thu 2026-02-26 17:45", "Sun 2026-03-01 17:45",
		"Wed 2026-03-04 17:45", "Sat 2026-03-07 17:45",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// A month without the anchor's day is skipped, not clamped: a meeting on the 31st
// does not silently move to the 28th.
func TestMonthlySkipsMonthsWithoutTheDay(t *testing.T) {
	r := Rule{Frequency: Monthly, Interval: 1, EndCondition: EndNever}
	s := mustSchedule(t, r, "2026-01-31 12:00", "UTC")
	got := wall(s.Loc, occurrences(s, 4))
	want := []string{
		"Sat 2026-01-31 12:00", "Tue 2026-03-31 12:00",
		"Sun 2026-05-31 12:00", "Fri 2026-07-31 12:00",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestMonthlyEveryTwoMonths(t *testing.T) {
	r := Rule{Frequency: Monthly, Interval: 2, EndCondition: EndNever}
	s := mustSchedule(t, r, "2026-11-15 09:00", "UTC")
	got := wall(s.Loc, occurrences(s, 3))
	want := []string{"Sun 2026-11-15 09:00", "Fri 2027-01-15 09:00", "Mon 2027-03-15 09:00"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Leap day: Feb 29 exists only in leap years, so a yearly-ish interval skips the
// years that lack it instead of looping or drifting.
func TestMonthlyLeapDayIsSkippedInCommonYears(t *testing.T) {
	r := Rule{Frequency: Monthly, Interval: 12, EndCondition: EndNever}
	s := mustSchedule(t, r, "2028-02-29 12:00", "UTC")
	got := wall(s.Loc, occurrences(s, 2))
	want := []string{"Tue 2028-02-29 12:00", "Sun 2032-02-29 12:00"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Wall-clock stability across the autumn change (Berlin: CEST -> CET on
// 2026-10-25). The meeting stays at 10:00 local, so its UTC instant moves.
func TestWeeklyKeepsWallClockAcrossDaylightSaving(t *testing.T) {
	s := mustSchedule(t, weekly(1, mon), "2026-10-19 10:00", "Europe/Berlin")
	occ := occurrences(s, 2)
	if got := occ[0].UTC().Format("15:04"); got != "08:00" {
		t.Errorf("before the change: %s UTC, want 08:00 (CEST)", got)
	}
	if got := occ[1].UTC().Format("15:04"); got != "09:00" {
		t.Errorf("after the change: %s UTC, want 09:00 (CET)", got)
	}
	for _, o := range occ {
		if got := o.In(s.Loc).Format("15:04"); got != "10:00" {
			t.Errorf("local time drifted to %s", got)
		}
	}
}

// Spring-forward in New York (2026-03-08): a 02:30 series has no 02:30 that day.
// The meeting must still occur exactly once on that date, and the day after
// returns to 02:30.
func TestDailyThroughASpringForwardGap(t *testing.T) {
	r := Rule{Frequency: Daily, Interval: 1, EndCondition: EndNever}
	s := mustSchedule(t, r, "2026-03-07 02:30", "America/New_York")
	occ := occurrences(s, 3)
	dates := []string{}
	for _, o := range occ {
		dates = append(dates, o.In(s.Loc).Format("2006-01-02"))
	}
	if !reflect.DeepEqual(dates, []string{"2026-03-07", "2026-03-08", "2026-03-09"}) {
		t.Fatalf("dates = %v; the gap day must still produce one occurrence", dates)
	}
	if got := occ[2].In(s.Loc).Format("15:04"); got != "02:30" {
		t.Errorf("the day after the gap is at %s, want 02:30", got)
	}
}

// A zone with a half-hour offset and no DST.
func TestHalfHourOffsetZone(t *testing.T) {
	s := mustSchedule(t, weekly(1, mon), "2026-10-05 09:00", "Asia/Kolkata")
	if got := occurrences(s, 1)[0].UTC().Format("15:04"); got != "03:30" {
		t.Errorf("09:00 IST = %s UTC, want 03:30", got)
	}
}

func TestEndOnDateIsInclusive(t *testing.T) {
	r := weekly(1, mon, wed, fri)
	r.EndCondition, r.EndDate = EndOnDate, "2026-10-14"
	s := mustSchedule(t, r, "2026-10-05 10:00", "UTC")
	got := wall(s.Loc, occurrences(s, 50))
	want := []string{
		"Mon 2026-10-05 10:00", "Wed 2026-10-07 10:00", "Fri 2026-10-09 10:00",
		"Mon 2026-10-12 10:00", "Wed 2026-10-14 10:00", // the end date itself is kept
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// The end DATE is read on the organiser's wall, not in UTC: 23:30 in Los Angeles
// on the 14th is already the 15th in UTC.
func TestEndDateIsReadInTheSeriesZone(t *testing.T) {
	r := Rule{Frequency: Daily, Interval: 1, EndCondition: EndOnDate, EndDate: "2026-10-14"}
	s := mustSchedule(t, r, "2026-10-12 23:30", "America/Los_Angeles")
	got := wall(s.Loc, occurrences(s, 10))
	if len(got) != 3 || got[2] != "Wed 2026-10-14 23:30" {
		t.Fatalf("got %v", got)
	}
}

func TestEndAfterOccurrencesCountsTheFirst(t *testing.T) {
	r := weekly(1, mon, wed, fri)
	r.EndCondition, r.OccurrenceCount = EndAfterCount, 4
	s := mustSchedule(t, r, "2026-10-05 10:00", "UTC")
	got := wall(s.Loc, occurrences(s, 50))
	if len(got) != 4 || got[3] != "Mon 2026-10-12 10:00" {
		t.Fatalf("got %v, want exactly four ending Mon 2026-10-12", got)
	}
}

func TestNeverEndingKeepsProducing(t *testing.T) {
	s := mustSchedule(t, weekly(1, mon), "2026-10-05 10:00", "UTC")
	if n := len(occurrences(s, 500)); n != 500 {
		t.Fatalf("produced %d of 500", n)
	}
}

// After is strict, works from the middle of a series, and does not walk
// occurrence by occurrence to get there (the search is arithmetic).
func TestAfterIsStrictAndJumpsStraightThere(t *testing.T) {
	s := mustSchedule(t, weekly(2, tue, thu), "2026-10-06 09:30", "UTC")
	tue1 := s.Anchor
	next, _ := s.After(tue1)
	if got := next.Format("Mon 15:04"); got != "Thu 09:30" {
		t.Errorf("After(an occurrence) = %s, want the next one", got)
	}
	far, ok := s.After(tue1.AddDate(8, 0, 3))
	if !ok || !far.After(tue1.AddDate(8, 0, 3)) {
		t.Fatalf("After far in the future = %v, %v", far, ok)
	}
	if far.Format("15:04") != "09:30" {
		t.Errorf("time of day drifted to %s", far.Format("15:04"))
	}
}

// Asked from INSIDE a skipped week, the answer must still respect "every 2 weeks":
// the next meeting is two weeks after the last, not the first matching weekday
// after the question. Enumerating from an occurrence always lands aligned, so
// only this direction catches an interval that is ignored.
func TestAfterFromASkippedWeekRespectsTheInterval(t *testing.T) {
	s := mustSchedule(t, weekly(2, tue, thu), "2026-10-06 09:30", "UTC")
	for _, q := range []string{"2026-10-12 00:00", "2026-10-14 12:00", "2026-10-18 23:59"} {
		at, _ := time.Parse("2006-01-02 15:04", q)
		next, ok := s.After(at)
		if !ok || next.Format("Mon 2006-01-02 15:04") != "Tue 2026-10-20 09:30" {
			t.Errorf("After(%s) = %v, want Tue 2026-10-20 09:30", q, next)
		}
	}
	// And every-3-days, from between two occurrences.
	d := mustSchedule(t, Rule{Frequency: Daily, Interval: 3, EndCondition: EndNever}, "2026-10-01 08:00", "UTC")
	at, _ := time.Parse("2006-01-02 15:04", "2026-10-02 12:00")
	if next, _ := d.After(at); next.Format("2006-01-02") != "2026-10-04" {
		t.Errorf("daily After = %v, want 2026-10-04", next)
	}
	// Every 2 months, from a skipped month.
	m := mustSchedule(t, Rule{Frequency: Monthly, Interval: 2, EndCondition: EndNever}, "2026-01-10 08:00", "UTC")
	at, _ = time.Parse("2006-01-02 15:04", "2026-02-20 00:00")
	if next, _ := m.After(at); next.Format("2006-01-02") != "2026-03-10" {
		t.Errorf("monthly After = %v, want 2026-03-10", next)
	}
}

func TestValidation(t *testing.T) {
	start := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC) // a Monday
	cases := []struct {
		name string
		rule Rule
		zone string
		want string
	}{
		{"no weekday", weekly(1), "UTC", "at least one weekday"},
		{"interval zero", weekly(0, mon), "UTC", "interval"},
		{"interval too large", weekly(MaxInterval+1, mon), "UTC", "interval"},
		{"negative interval", Rule{Frequency: Daily, Interval: -1, EndCondition: EndNever}, "UTC", "interval"},
		{"weekday out of range", weekly(1, 7), "UTC", "weekdays must be"},
		{"duplicate weekday", weekly(1, mon, mon), "UTC", "must not repeat"},
		{"weekdays on a daily rule", Rule{Frequency: Daily, Interval: 1, Weekdays: []int{mon}, EndCondition: EndNever}, "UTC", "only valid for weekly"},
		{"unknown frequency", Rule{Frequency: "YEARLY", Interval: 1, EndCondition: EndNever}, "UTC", "frequency"},
		{"unknown end condition", Rule{Frequency: Daily, Interval: 1, EndCondition: "SOMETIME"}, "UTC", "endCondition"},
		{"end date before the start", Rule{Frequency: Daily, Interval: 1, EndCondition: EndOnDate, EndDate: "2026-10-04"}, "UTC", "before the meeting"},
		{"end date malformed", Rule{Frequency: Daily, Interval: 1, EndCondition: EndOnDate, EndDate: "31/12/2026"}, "UTC", "endDate must be a date"},
		{"end date missing", Rule{Frequency: Daily, Interval: 1, EndCondition: EndOnDate}, "UTC", "endDate must be a date"},
		{"end date absurdly far", Rule{Frequency: Daily, Interval: 1, EndCondition: EndOnDate, EndDate: "2099-01-01"}, "UTC", "within"},
		{"end date with no occurrence in range", Rule{Frequency: Weekly, Interval: 1, Weekdays: []int{fri}, EndCondition: EndOnDate, EndDate: "2026-10-06"}, "UTC", "no occurrence"},
		{"count zero", Rule{Frequency: Daily, Interval: 1, EndCondition: EndAfterCount}, "UTC", "occurrenceCount"},
		{"count too large", Rule{Frequency: Daily, Interval: 1, EndCondition: EndAfterCount, OccurrenceCount: MaxOccurrences + 1}, "UTC", "occurrenceCount"},
		{"stray count", Rule{Frequency: Daily, Interval: 1, EndCondition: EndNever, OccurrenceCount: 3}, "UTC", "not valid"},
		{"stray end date", Rule{Frequency: Daily, Interval: 1, EndCondition: EndAfterCount, OccurrenceCount: 3, EndDate: "2026-12-01"}, "UTC", "endDate is only valid"},
		{"empty zone", weekly(1, mon), "", "timeZone"},
		{"local zone", weekly(1, mon), "Local", "timeZone"},
		{"unknown zone", weekly(1, mon), "Mars/Olympus_Mons", "unknown timeZone"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := New(c.rule, start, c.zone)
			if err == nil {
				t.Fatal("accepted an invalid rule")
			}
			if !errors.Is(err, ErrInvalid) {
				t.Errorf("error %v does not wrap ErrInvalid", err)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error %q does not mention %q", err, c.want)
			}
		})
	}
}

// New sorts the weekdays it accepts, so callers may send them in any order.
func TestWeekdaysAreAcceptedInAnyOrder(t *testing.T) {
	s := mustSchedule(t, weekly(1, fri, mon, wed), "2026-10-05 10:00", "UTC")
	if !reflect.DeepEqual(s.Rule.Weekdays, []int{mon, wed, fri}) {
		t.Errorf("weekdays = %v", s.Rule.Weekdays)
	}
	if got := wall(s.Loc, occurrences(s, 3)); got[1] != "Wed 2026-10-07 10:00" {
		t.Errorf("got %v", got)
	}
}

// The bound on a fully valid rule at its limits.
func TestLimitsAreInclusive(t *testing.T) {
	start := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	for _, r := range []Rule{
		{Frequency: Daily, Interval: MaxInterval, EndCondition: EndNever},
		{Frequency: Monthly, Interval: MaxInterval, EndCondition: EndNever},
		{Frequency: Daily, Interval: 1, EndCondition: EndAfterCount, OccurrenceCount: MaxOccurrences},
		{Frequency: Daily, Interval: 1, EndCondition: EndAfterCount, OccurrenceCount: 1},
		{Frequency: Weekly, Interval: 1, Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, EndCondition: EndNever},
	} {
		if _, err := New(r, start, "UTC"); err != nil {
			t.Errorf("%+v refused: %v", r, err)
		}
	}
}

// ── Boundaries, leap years, and more zones ──────────────────────────────────────

func TestDailyAcrossALeapDay(t *testing.T) {
	r := Rule{Frequency: Daily, Interval: 1, EndCondition: EndNever}
	s := mustSchedule(t, r, "2028-02-27 08:00", "UTC")
	got := wall(s.Loc, occurrences(s, 4))
	want := []string{"Sun 2028-02-27 08:00", "Mon 2028-02-28 08:00", "Tue 2028-02-29 08:00", "Wed 2028-03-01 08:00"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Every 4 weeks from 1 Feb 2028 lands on 29 Feb (a leap day) and steps over it cleanly.
func TestWeeklyThroughALeapDayAndAMonthEnd(t *testing.T) {
	s := mustSchedule(t, weekly(1, tue), "2028-02-22 09:00", "UTC")
	got := wall(s.Loc, occurrences(s, 3))
	want := []string{"Tue 2028-02-22 09:00", "Tue 2028-02-29 09:00", "Tue 2028-03-07 09:00"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// The stated monthly semantics: the SAME DAY OF THE MONTH, and a month without it is
// SKIPPED — not clamped to its last day, not carried into the next month.
func TestMonthlySameDayShortMonthsSkipped(t *testing.T) {
	t.Run("the 31st happens in seven months of the year", func(t *testing.T) {
		r := Rule{Frequency: Monthly, Interval: 1, EndCondition: EndNever}
		s := mustSchedule(t, r, "2026-01-31 12:00", "UTC")
		var months []string
		for _, o := range occurrences(s, 7) {
			months = append(months, o.Format("2006-01-02"))
		}
		want := []string{"2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31", "2026-10-31", "2026-12-31"}
		if !reflect.DeepEqual(months, want) {
			t.Fatalf("got %v want %v", months, want)
		}
	})
	t.Run("the 30th skips only February", func(t *testing.T) {
		r := Rule{Frequency: Monthly, Interval: 1, EndCondition: EndNever}
		s := mustSchedule(t, r, "2026-01-30 12:00", "UTC")
		got := occurrences(s, 3)
		if got[1].Format("2006-01-02") != "2026-03-30" || got[2].Format("2006-01-02") != "2026-04-30" {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("the 29th returns in the next leap year", func(t *testing.T) {
		r := Rule{Frequency: Monthly, Interval: 1, EndCondition: EndNever}
		s := mustSchedule(t, r, "2027-01-29 12:00", "UTC")
		var feb []string
		for _, o := range occurrences(s, 30) {
			if o.Month() == time.February {
				feb = append(feb, o.Format("2006-01-02"))
			}
		}
		if !reflect.DeepEqual(feb, []string{"2028-02-29"}) {
			t.Fatalf("Februaries with a 29th in the next 30 occurrences: %v", feb)
		}
	})
	t.Run("every two months crosses a year boundary", func(t *testing.T) {
		r := Rule{Frequency: Monthly, Interval: 2, EndCondition: EndNever}
		s := mustSchedule(t, r, "2026-11-30 09:00", "UTC")
		got := wall(s.Loc, occurrences(s, 3))
		// Nov 30, Jan 30, then March 30 — never Feb, which the interval skips anyway.
		want := []string{"Mon 2026-11-30 09:00", "Sat 2027-01-30 09:00", "Tue 2027-03-30 09:00"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v want %v", got, want)
		}
	})
}

// Sunday belongs to the week that began on the Monday BEFORE it, so "every 2 weeks on
// Sunday and Monday" starting on a Sunday takes its Monday from the week AFTER.
func TestEveryTwoWeeksFromASundayAnchor(t *testing.T) {
	s := mustSchedule(t, weekly(2, mon, sun), "2026-10-11 10:00", "UTC")
	got := wall(s.Loc, occurrences(s, 5))
	want := []string{"Sun 2026-10-11 10:00", "Mon 2026-10-19 10:00", "Sun 2026-10-25 10:00", "Mon 2026-11-02 10:00", "Sun 2026-11-08 10:00"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestEveryTwoWeeksAcrossTheYearBoundary(t *testing.T) {
	s := mustSchedule(t, weekly(2, tue, thu), "2026-12-22 09:00", "UTC")
	got := wall(s.Loc, occurrences(s, 6))
	want := []string{
		"Tue 2026-12-22 09:00", "Thu 2026-12-24 09:00",
		"Tue 2027-01-05 09:00", "Thu 2027-01-07 09:00",
		"Tue 2027-01-19 09:00", "Thu 2027-01-21 09:00",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

// Fall back in New York (2026-11-01): 01:30 happens twice. The meeting still occurs
// exactly ONCE that day, at 01:30 on the wall, and the days either side are normal.
func TestDailyThroughAFallBackOverlap(t *testing.T) {
	r := Rule{Frequency: Daily, Interval: 1, EndCondition: EndNever}
	s := mustSchedule(t, r, "2026-10-31 01:30", "America/New_York")
	occ := occurrences(s, 3)
	var days []string
	for _, o := range occ {
		days = append(days, o.In(s.Loc).Format("2006-01-02 15:04"))
	}
	if !reflect.DeepEqual(days, []string{"2026-10-31 01:30", "2026-11-01 01:30", "2026-11-02 01:30"}) {
		t.Fatalf("got %v", days)
	}
	if !occ[1].After(occ[0]) || !occ[2].After(occ[1]) {
		t.Error("occurrences are not strictly increasing through the overlap")
	}
}

// The southern hemisphere changes the other way, in October: the local time holds and
// the UTC hour moves by one.
func TestSouthernHemisphereDaylightSaving(t *testing.T) {
	s := mustSchedule(t, weekly(1, mon), "2026-09-28 10:00", "Australia/Sydney")
	occ := occurrences(s, 2) // 28 Sep (AEST +10) and 5 Oct (AEDT +11; it began 4 Oct)
	if a, b := occ[0].UTC().Format("15:04"), occ[1].UTC().Format("15:04"); a != "00:00" || b != "23:00" {
		t.Errorf("UTC times = %s, %s; want 00:00 then 23:00 the day before", a, b)
	}
	for _, o := range occ {
		if got := o.In(s.Loc).Format("15:04"); got != "10:00" {
			t.Errorf("local time drifted to %s", got)
		}
	}
}

// Lord Howe Island shifts by THIRTY minutes, not an hour.
func TestHalfHourDaylightSaving(t *testing.T) {
	r := Rule{Frequency: Daily, Interval: 1, EndCondition: EndNever}
	s := mustSchedule(t, r, "2026-10-03 12:00", "Australia/Lord_Howe")
	occ := occurrences(s, 3) // DST begins 4 Oct 2026
	if gap := occ[1].Sub(occ[0]); gap != 23*time.Hour+30*time.Minute {
		t.Errorf("gap across the change = %v, want 23h30m", gap)
	}
	for _, o := range occ {
		if got := o.In(s.Loc).Format("15:04"); got != "12:00" {
			t.Errorf("local time drifted to %s", got)
		}
	}
}

// Zones without daylight saving never move in UTC, across a whole year.
func TestNoDaylightSavingZonesNeverShift(t *testing.T) {
	for _, zone := range []string{"UTC", "Asia/Tokyo", "Asia/Kolkata", "Asia/Kathmandu", "Africa/Nairobi"} {
		t.Run(zone, func(t *testing.T) {
			s := mustSchedule(t, weekly(1, wed), "2026-01-07 09:15", zone)
			occ := occurrences(s, 52)
			first := occ[0].UTC().Format("15:04")
			for i, o := range occ {
				if got := o.UTC().Format("15:04"); got != first {
					t.Fatalf("occurrence %d moved to %s UTC from %s", i, got, first)
				}
			}
		})
	}
}

// ── A brute-force oracle ─────────────────────────────────────────────────────────

// oracle lists the first n occurrences the DUMB way: look at every civil day from the
// anchor, and keep the days that satisfy the rule's plain definition. It shares none
// of the engine's arithmetic (no round-up, no jumping ahead), so agreement between
// the two is evidence about the engine rather than about my expectations.
func oracle(rule Rule, anchor time.Time, loc *time.Location, n int) []time.Time {
	a := anchor.In(loc)
	ay, am, ad := a.Date()
	hh, mm := a.Hour(), a.Minute()
	anchorDay := time.Date(ay, am, ad, 0, 0, 0, 0, time.UTC)
	anchorWD := (int(anchorDay.Weekday()) + 6) % 7
	days := map[int]bool{}
	for _, d := range rule.Weekdays {
		days[d] = true
	}
	var out []time.Time
	for off := 0; len(out) < n && off < 40000; off++ {
		d := anchorDay.AddDate(0, 0, off)
		var ok bool
		switch rule.Frequency {
		case Daily:
			ok = off%rule.Interval == 0
		case Weekly:
			ok = days[(int(d.Weekday())+6)%7] && ((off+anchorWD)/7)%rule.Interval == 0
		case Monthly:
			months := (d.Year()-ay)*12 + int(d.Month()-am)
			ok = d.Day() == ad && months%rule.Interval == 0
		}
		if ok {
			out = append(out, time.Date(d.Year(), d.Month(), d.Day(), hh, mm, 0, 0, loc))
		}
	}
	return out
}

func TestEngineAgreesWithABruteForceOracleOnRandomRules(t *testing.T) {
	zones := []string{"UTC", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Kolkata",
		"Asia/Tokyo", "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Auckland", "America/Sao_Paulo", "Africa/Cairo"}
	rng := rand.New(rand.NewSource(20260928))
	freqs := []string{Daily, Weekly, Monthly}
	const cases = 400
	for i := 0; i < cases; i++ {
		zone := zones[rng.Intn(len(zones))]
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		rule := Rule{Frequency: freqs[rng.Intn(3)], Interval: 1 + rng.Intn(12), EndCondition: EndNever}
		if rng.Intn(6) == 0 {
			rule.Interval = 1 + rng.Intn(MaxInterval)
		}
		if rule.Frequency == Weekly {
			for d := 0; d < 7; d++ {
				if rng.Intn(3) == 0 {
					rule.Weekdays = append(rule.Weekdays, d)
				}
			}
			if len(rule.Weekdays) == 0 {
				rule.Weekdays = []int{rng.Intn(7)}
			}
		}
		anchor := time.Date(2024+rng.Intn(7), time.Month(1+rng.Intn(12)), 1+rng.Intn(31), rng.Intn(24), rng.Intn(60), 0, 0, loc)
		s, err := New(rule, anchor, zone)
		if err != nil {
			t.Fatalf("case %d: %+v refused: %v", i, rule, err)
		}
		// The oracle's first occurrence is the anchor's own date only if the rule
		// matches it; the engine starts at the first match on or after it. Same thing.
		want := oracle(s.Rule, s.Anchor, loc, 40)
		got := occurrences(s, 40)
		if len(got) < len(want) {
			want = want[:len(got)]
		}
		for j := range want {
			if !got[j].Equal(want[j]) {
				t.Fatalf("case %d (%s, %+v, anchor %v): occurrence %d is %v, oracle says %v",
					i, zone, s.Rule, s.Anchor.In(loc), j, got[j].In(loc), want[j].In(loc))
			}
		}
		if len(got) < 40 && rule.Frequency != Monthly {
			t.Fatalf("case %d produced only %d occurrences", i, len(got))
		}

		// And After from ARBITRARY instants, which is what an edit and a top-up ask.
		// Walking from one occurrence to the next always lands on the rule's rhythm;
		// asking from the middle of a skipped week or month is what shows whether the
		// rhythm is really being honoured.
		if len(want) < 6 {
			continue
		}
		span := want[len(want)-3].Sub(want[0])
		for k := 0; k < 8; k++ {
			at := want[0].Add(-time.Hour).Add(time.Duration(rng.Int63n(int64(span))))
			next, ok := s.After(at)
			var expect time.Time
			for _, o := range want {
				if o.After(at) {
					expect = o
					break
				}
			}
			if !ok || !next.Equal(expect) {
				t.Fatalf("case %d (%s, %+v): After(%v) = %v, oracle says %v",
					i, zone, s.Rule, at.In(loc), next.In(loc), expect.In(loc))
			}
		}
	}
}
