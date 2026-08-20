package api

import (
	"testing"
	"time"
)

// A call's scheduled end is what lets the sweeper close a meeting whose
// organiser never came back to end it. The rule about WHICH calls get one is
// the part worth pinning down: a call in the diary has an implied length, and
// an ad-hoc one does not, so inventing a default for the second would cut off
// live calls nobody asked to be cut off.
func TestParseScheduleDerivesTheEndFromTheDuration(t *testing.T) {
	const start = "2026-09-01T10:00:00Z"
	at, err := time.Parse(time.RFC3339, start)
	if err != nil {
		t.Fatalf("test fixture: %v", err)
	}

	cases := []struct {
		name string
		req  scheduleCallReq
		want *time.Time
	}{
		{
			name: "a scheduled call with no duration gets the default hour",
			req:  scheduleCallReq{ScheduledAt: start},
			want: ptr(at.Add(defaultCallMinutes * time.Minute)),
		}, {
			name: "an explicit duration is measured from the scheduled start",
			req:  scheduleCallReq{ScheduledAt: start, DurationMinutes: 25},
			want: ptr(at.Add(25 * time.Minute)),
		}, {
			// "Meet now" is the call button, not an appointment. Giving it a
			// default hour would end a live conversation on a clock nobody set.
			name: "meet now with no duration has no scheduled end at all",
			req:  scheduleCallReq{},
			want: nil,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sc, ok := parseSchedule(c.req)
			if !ok {
				t.Fatal("parseSchedule refused a valid request")
			}
			switch {
			case c.want == nil && sc.EndsAt != nil:
				t.Fatalf("endsAt = %v, want none", *sc.EndsAt)
			case c.want != nil && sc.EndsAt == nil:
				t.Fatalf("endsAt = none, want %v", *c.want)
			case c.want != nil && !sc.EndsAt.Equal(*c.want):
				t.Fatalf("endsAt = %v, want %v", *sc.EndsAt, *c.want)
			}
		})
	}
}

// "Meet now, for 30 minutes" is a real request, and its end has to be measured
// from now rather than from the start it does not have — a nil start that
// silently dropped the duration would be a call that never expires.
func TestParseScheduleMeasuresAnAdHocDurationFromNow(t *testing.T) {
	before := time.Now().UTC()
	sc, ok := parseSchedule(scheduleCallReq{DurationMinutes: 30})
	if !ok {
		t.Fatal("parseSchedule refused a valid request")
	}
	if sc.EndsAt == nil {
		t.Fatal("an explicit duration on a meet-now produced no end")
	}
	if sc.EndsAt.Before(before.Add(29*time.Minute)) ||
		sc.EndsAt.After(time.Now().UTC().Add(31*time.Minute)) {
		t.Fatalf("endsAt = %v, want roughly 30 minutes from now", *sc.EndsAt)
	}
}

// A duration this service will not honour must be refused at the boundary
// rather than clamped: a typo'd 100000 written as an `ends_at` years out is
// indistinguishable from having no end, which is the bug this all exists to fix.
func TestParseScheduleRefusesADurationItWillNotHonour(t *testing.T) {
	for _, mins := range []int{-1, maxCallMinutes + 1} {
		if _, ok := parseSchedule(scheduleCallReq{DurationMinutes: mins}); ok {
			t.Errorf("durationMinutes=%d was accepted", mins)
		}
	}
	// The bound itself is inclusive — a twelve-hour booking is legal.
	if _, ok := parseSchedule(scheduleCallReq{DurationMinutes: maxCallMinutes}); !ok {
		t.Errorf("durationMinutes=%d was refused at the boundary", maxCallMinutes)
	}
}

func ptr(t time.Time) *time.Time { return &t }
