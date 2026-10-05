package store

import (
	"time"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// occurrencePlan is what planOccurrences is asked: from where, how many already
// count toward the end, how far ahead, and which instants must not be written.
type occurrencePlan struct {
	Sched recurrence.Schedule
	// Start is the first candidate instant, or nil for "there is nothing left".
	Start *time.Time
	// Produced is how many occurrences already count toward an "after N" end.
	Produced int
	// Horizon is how far ahead to write.
	Horizon time.Time
	// AtLeastOne plans the first occurrence even past the horizon: a series that
	// starts in six months must still appear on the calendar. For creating and
	// editing a series; NOT for topping one up, which has by definition already
	// written what it needs and must not write beyond the horizon.
	AtLeastOne bool
	// Limit bounds one plan, so one transaction cannot write a huge batch.
	Limit int
	// Exists are instants (unix seconds) that already have an occurrence. They are
	// stepped over — never planned again, never counted again — because the caller
	// already counts them in Produced.
	Exists map[int64]bool
	// NotBefore, when set, steps over instants earlier than it WITHOUT counting them.
	// A series that was paused (its organiser inactive, the service down for weeks)
	// resumes from now; it does not write meetings that are already over and have
	// the sweeper start them all at once.
	NotBefore time.Time
}

// planOccurrences works out which occurrences to write and where the series' cursor
// should sit afterwards (nil once the series is finished).
//
// Pure: no database, no clock. It is the ONE place that decides what "the next
// occurrences" are, shared by creating a series, topping it up and editing it, so
// the three cannot disagree about where a series' end is or step onto an instant
// that already exists (which the unique index would then refuse).
func planOccurrences(p occurrencePlan) ([]time.Time, *time.Time) {
	advance := func(t time.Time) *time.Time {
		next, ok := p.Sched.After(t)
		if !ok {
			return nil
		}
		return &next
	}
	// settle moves the cursor past instants that must not be written.
	settle := func(cur *time.Time) *time.Time {
		for cur != nil && (p.Exists[cur.Unix()] || (!p.NotBefore.IsZero() && cur.Before(p.NotBefore))) {
			cur = advance(*cur)
		}
		return cur
	}

	var planned []time.Time
	cur := settle(p.Start)
	for cur != nil && len(planned) < p.Limit {
		if cur.After(p.Horizon) && (len(planned) > 0 || !p.AtLeastOne) {
			break
		}
		if !p.Sched.Allows(*cur, p.Produced+len(planned)) {
			cur = nil
			break
		}
		planned = append(planned, *cur)
		cur = settle(advance(*cur))
	}
	// A cursor the end condition will refuse is no cursor: the series is finished.
	if cur != nil && !p.Sched.Allows(*cur, p.Produced+len(planned)) {
		cur = nil
	}
	return planned, cur
}
