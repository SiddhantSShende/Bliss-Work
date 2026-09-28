// Package recurrence works out WHEN a repeating meeting falls.
//
// Pure: no database, no clock. Everything is a function of the rule, the first
// start and the series' time zone, which is what makes it testable across
// daylight-saving changes without waiting for one.
//
// ── Wall-clock, not fixed-offset ─────────────────────────────────────────────
// "Every Monday at 10:00" means 10:00 on the organiser's wall clock. Adding
// seven days of absolute time to an instant would drift an hour either side of a
// daylight-saving change, so every occurrence is computed as a civil date plus
// the anchor's local time of day, in the series' own IANA zone, and only then
// converted to an instant.
//
// A local time that does not exist (the spring-forward gap) or exists twice (the
// fall-back overlap) is resolved the way Go's time.Date resolves it. That is
// deterministic per zone and date, which is all a schedule needs: the meeting
// still happens exactly once on that date.
//
// ── Shape ────────────────────────────────────────────────────────────────────
// The vocabulary matches task-svc's task_schedules (DAILY/WEEKLY/MONTHLY,
// NO_END/ON_DATE/AFTER_OCCURRENCES, weekdays 0=Monday..6=Sunday) so the two
// recurring features read the same to clients. One deliberate difference: an
// end is a calendar DATE in the series' zone, not an instant, because "until
// 31 December" is a statement about a day on somebody's wall.
package recurrence

import (
	"errors"
	"fmt"
	"sort"
	"time"
	// The runtime image is alpine with no zoneinfo, so time.LoadLocation would
	// fail for every zone but UTC. This embeds the IANA database (~450 KB).
	_ "time/tzdata"
)

// Frequencies.
const (
	Daily   = "DAILY"
	Weekly  = "WEEKLY"
	Monthly = "MONTHLY"
)

// End conditions.
const (
	EndNever      = "NO_END"
	EndOnDate     = "ON_DATE"
	EndAfterCount = "AFTER_OCCURRENCES"
)

const (
	// MaxInterval bounds "every N days/weeks/months". Far past anything a real
	// calendar offers, and it keeps the search below bounded.
	MaxInterval = 99
	// MaxOccurrences bounds "after N occurrences".
	MaxOccurrences = 999
	// maxEndYears bounds how far out an end date may sit. A "never" series is
	// unbounded by design; this only refuses a nonsense date (year 9999) that
	// would otherwise be accepted as a real one.
	maxEndYears = 10
	// maxMonthlyScan bounds the month search: an interval that only lands on
	// months lacking the anchor's day (the 31st) may need to skip several.
	maxMonthlyScan = 600
	maxZoneNameLen = 64
	dateLayout     = "2006-01-02"
)

// ErrInvalid wraps every reason a rule is refused, so a caller can turn the lot
// into one 400 and still show the specific message.
var ErrInvalid = errors.New("invalid recurrence")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Rule is what the organiser chose. Zero values mean "not set".
type Rule struct {
	Frequency string
	// Interval is "every N": days, weeks or months by Frequency.
	Interval int
	// Weekdays are 0=Monday..6=Sunday. Required for WEEKLY, forbidden otherwise.
	Weekdays     []int
	EndCondition string
	// EndDate is the last local calendar day an occurrence may START on
	// (inclusive), "YYYY-MM-DD". ON_DATE only.
	EndDate string
	// OccurrenceCount is the total number of occurrences, the first included.
	// AFTER_OCCURRENCES only.
	OccurrenceCount int
}

// Schedule is a validated rule anchored at a first start in a time zone.
type Schedule struct {
	Rule Rule
	Loc  *time.Location
	// Anchor is the first start, truncated to the minute. Its local DATE fixes
	// which weeks (every 2 weeks) and which day of the month (monthly) repeat;
	// its local CLOCK is the time of day of every occurrence.
	Anchor time.Time
}

// LoadLocation resolves an IANA zone name. "Local" is refused: it means the
// SERVER's zone, which is never what a client meant.
func LoadLocation(name string) (*time.Location, error) {
	if name == "" || len(name) > maxZoneNameLen || name == "Local" {
		return nil, invalid("timeZone must be an IANA zone name such as Europe/Berlin")
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, invalid("unknown timeZone %q", name)
	}
	return loc, nil
}

// New validates rule against its first start and time zone.
//
// Beyond field checks it insists the rule actually produces a first occurrence
// that its own end condition allows — "weekly on Friday, ending Tuesday" is
// refused here rather than accepted as a series that never meets.
func New(rule Rule, firstStart time.Time, timeZone string) (Schedule, error) {
	loc, err := LoadLocation(timeZone)
	if err != nil {
		return Schedule{}, err
	}
	s := Schedule{Rule: rule, Loc: loc, Anchor: firstStart.Truncate(time.Minute)}
	if err := s.validate(); err != nil {
		return Schedule{}, err
	}
	first, ok := s.After(s.Anchor.Add(-time.Nanosecond))
	if !ok || !s.Allows(first, 0) {
		return Schedule{}, invalid("no occurrence falls on or before the end date")
	}
	return s, nil
}

func (s *Schedule) validate() error {
	r := &s.Rule
	switch r.Frequency {
	case Daily, Weekly, Monthly:
	default:
		return invalid("frequency must be DAILY, WEEKLY or MONTHLY")
	}
	if r.Interval < 1 || r.Interval > MaxInterval {
		return invalid("interval must be between 1 and %d", MaxInterval)
	}
	if err := s.normaliseWeekdays(); err != nil {
		return err
	}
	switch r.EndCondition {
	case EndNever:
		if r.EndDate != "" || r.OccurrenceCount != 0 {
			return invalid("endDate and occurrenceCount are not valid when the series never ends")
		}
	case EndOnDate:
		if r.OccurrenceCount != 0 {
			return invalid("occurrenceCount is only valid when the series ends after a number of occurrences")
		}
		return s.validateEndDate()
	case EndAfterCount:
		if r.EndDate != "" {
			return invalid("endDate is only valid when the series ends on a date")
		}
		if r.OccurrenceCount < 1 || r.OccurrenceCount > MaxOccurrences {
			return invalid("occurrenceCount must be between 1 and %d", MaxOccurrences)
		}
	default:
		return invalid("endCondition must be NO_END, ON_DATE or AFTER_OCCURRENCES")
	}
	return nil
}

// normaliseWeekdays checks the weekday list and stores it sorted, so the search
// can walk it in calendar order. A repeated weekday is refused rather than
// silently collapsed: it means the client's picker is broken.
func (s *Schedule) normaliseWeekdays() error {
	r := &s.Rule
	if r.Frequency != Weekly {
		if len(r.Weekdays) > 0 {
			return invalid("weekdays are only valid for weekly recurrence")
		}
		return nil
	}
	if len(r.Weekdays) == 0 {
		return invalid("weekly recurrence needs at least one weekday")
	}
	seen := make(map[int]bool, len(r.Weekdays))
	days := make([]int, 0, len(r.Weekdays))
	for _, d := range r.Weekdays {
		if d < 0 || d > 6 {
			return invalid("weekdays must be 0 (Monday) through 6 (Sunday)")
		}
		if seen[d] {
			return invalid("weekdays must not repeat")
		}
		seen[d] = true
		days = append(days, d)
	}
	sort.Ints(days)
	r.Weekdays = days
	return nil
}

func (s *Schedule) validateEndDate() error {
	end, err := time.Parse(dateLayout, s.Rule.EndDate)
	if err != nil {
		return invalid("endDate must be a date such as 2026-12-31")
	}
	a := s.Anchor.In(s.Loc)
	start := time.Date(a.Year(), a.Month(), a.Day(), 0, 0, 0, 0, time.UTC)
	if end.Before(start) {
		return invalid("endDate must not be before the meeting's start date")
	}
	if end.After(start.AddDate(maxEndYears, 0, 0)) {
		return invalid("endDate must be within %d years of the start date", maxEndYears)
	}
	return nil
}

// Allows reports whether an occurrence starting at `at` may be produced when
// `produced` occurrences already exist — the end condition, and nothing else.
func (s Schedule) Allows(at time.Time, produced int) bool {
	switch s.Rule.EndCondition {
	case EndOnDate:
		// ISO dates order lexicographically.
		return at.In(s.Loc).Format(dateLayout) <= s.Rule.EndDate
	case EndAfterCount:
		return produced < s.Rule.OccurrenceCount
	default:
		return true
	}
}

// After returns the first occurrence STRICTLY after t, ignoring the end
// condition (see Allows). False only if the search bound is exhausted.
func (s Schedule) After(t time.Time) (time.Time, bool) {
	a := s.Anchor.In(s.Loc)
	tl := t.In(s.Loc)
	q := search{
		s: s, t: t, hour: a.Hour(), minute: a.Minute(),
		anchorDay: civil(a.Year(), a.Month(), a.Day()),
		from:      civil(tl.Year(), tl.Month(), tl.Day()),
	}
	if q.from.Before(q.anchorDay) {
		q.from = q.anchorDay
	}
	switch s.Rule.Frequency {
	case Daily:
		return q.daily()
	case Weekly:
		return q.weekly()
	case Monthly:
		return q.monthly()
	}
	return time.Time{}, false
}

// search is one call to After: the question (`t`, and `from`, the first civil day
// worth looking at) and the schedule's fixed answers (the anchor's day and clock).
type search struct {
	s               Schedule
	t               time.Time
	anchorDay, from time.Time
	hour, minute    int
}

// at is the instant of an occurrence on `day`, and whether it is after t.
func (q search) at(day time.Time) (time.Time, bool) {
	i := time.Date(day.Year(), day.Month(), day.Day(), q.hour, q.minute, 0, 0, q.s.Loc)
	return i, i.After(q.t)
}

func (q search) daily() (time.Time, bool) {
	step := q.s.Rule.Interval
	k := roundUp(daysBetween(q.anchorDay, q.from), step)
	for n := 0; n < 3; n++ {
		if i, ok := q.at(q.anchorDay.AddDate(0, 0, k)); ok {
			return i, true
		}
		k += step
	}
	return time.Time{}, false
}

// weekly walks the weeks that "every N weeks" keeps — counted from the anchor's
// Monday — and, inside each, the chosen weekdays in calendar order.
func (q search) weekly() (time.Time, bool) {
	step := q.s.Rule.Interval
	monday := q.anchorDay.AddDate(0, 0, -weekdayIndex(q.anchorDay))
	fromMonday := q.from.AddDate(0, 0, -weekdayIndex(q.from))
	w := roundUp(daysBetween(monday, fromMonday)/7, step)
	for n := 0; n < 3; n++ {
		for _, wd := range q.s.Rule.Weekdays {
			day := monday.AddDate(0, 0, w*7+wd)
			if day.Before(q.from) {
				continue
			}
			if i, ok := q.at(day); ok {
				return i, true
			}
		}
		w += step
	}
	return time.Time{}, false
}

// monthly keeps the anchor's day of the month. A month without it (the 31st, Feb
// 29th) is skipped rather than shifted, the same rule task-svc's monthly
// schedules follow.
func (q search) monthly() (time.Time, bool) {
	step := q.s.Rule.Interval
	day := q.anchorDay.Day()
	months := (q.from.Year()-q.anchorDay.Year())*12 + int(q.from.Month()-q.anchorDay.Month())
	k := roundUp(months, step)
	for n := 0; n < maxMonthlyScan; n++ {
		y, m := addMonths(q.anchorDay.Year(), q.anchorDay.Month(), k)
		if day <= daysIn(y, m) {
			if d := civil(y, m, day); !d.Before(q.from) {
				if i, ok := q.at(d); ok {
					return i, true
				}
			}
		}
		k += step
	}
	return time.Time{}, false
}

// ── civil-date arithmetic ────────────────────────────────────────────────────
// Dates are UTC midnights so day counts are exact multiples of 24h; the zone
// only enters when a date is turned into an instant.

func civil(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func daysBetween(a, b time.Time) int { return int(b.Sub(a) / (24 * time.Hour)) }

// weekdayIndex is 0=Monday..6=Sunday; time.Weekday has Sunday at 0.
func weekdayIndex(d time.Time) int { return (int(d.Weekday()) + 6) % 7 }

// roundUp is the smallest multiple of step that is >= n (and >= 0).
func roundUp(n, step int) int {
	if n <= 0 {
		return 0
	}
	return (n + step - 1) / step * step
}

func addMonths(y int, m time.Month, k int) (int, time.Month) {
	idx := y*12 + int(m) - 1 + k
	return idx / 12, time.Month(idx%12 + 1)
}

func daysIn(y int, m time.Month) int { return civil(y, m+1, 0).Day() }
