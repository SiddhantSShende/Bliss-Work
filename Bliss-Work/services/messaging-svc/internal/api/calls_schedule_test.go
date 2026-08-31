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
			req:  scheduleCallReq{ScheduledAt: start, DurationMinutes: intPtr(25)},
			want: ptr(at.Add(25 * time.Minute)),
		}, {
			// Regression test: DurationMinutes used to be a bare int, so an
			// explicit 0 ("No end time" — ScheduleCallDialog's own option) was
			// indistinguishable from omitting the field, and every scheduled
			// meeting with "No end time" silently got the 60-minute default
			// anyway — the one thing the field's own doc comment said should
			// never happen for a call that HAS a scheduledAt.
			name: "a scheduled call with an EXPLICIT zero duration gets no end time at all",
			req:  scheduleCallReq{ScheduledAt: start, DurationMinutes: intPtr(0)},
			want: nil,
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
	sc, ok := parseSchedule(scheduleCallReq{DurationMinutes: intPtr(30)})
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
		if _, ok := parseSchedule(scheduleCallReq{DurationMinutes: intPtr(mins)}); ok {
			t.Errorf("durationMinutes=%d was accepted", mins)
		}
	}
	// The bound itself is inclusive — a twelve-hour booking is legal.
	if _, ok := parseSchedule(scheduleCallReq{DurationMinutes: intPtr(maxCallMinutes)}); !ok {
		t.Errorf("durationMinutes=%d was refused at the boundary", maxCallMinutes)
	}
}

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

func TestParseScheduleAcceptsAnEmptyScheduledAtAsStartNow(t *testing.T) {
	sc, ok := parseSchedule(scheduleCallReq{Title: "Weekly review"})
	if !ok {
		t.Fatal("parseSchedule rejected a request with no scheduledAt at all")
	}
	if sc.At != nil {
		t.Errorf("At = %v, want nil for start-now", sc.At)
	}
}

func TestParseScheduleAcceptsAFutureScheduledAt(t *testing.T) {
	at := time.Now().Add(time.Hour)
	sc, ok := parseSchedule(scheduleCallReq{Title: "Weekly review", ScheduledAt: rfc3339(at)})
	if !ok {
		t.Fatal("parseSchedule rejected a plain future scheduledAt")
	}
	if sc.At == nil {
		t.Fatal("At is nil for a future scheduledAt")
	}
	if diff := sc.At.Sub(at).Abs(); diff > time.Second {
		t.Errorf("At = %v, want ~%v (diff %v)", sc.At, at, diff)
	}
}

func TestParseScheduleRejectsAMalformedScheduledAt(t *testing.T) {
	if _, ok := parseSchedule(scheduleCallReq{Title: "x", ScheduledAt: "not-a-date"}); ok {
		t.Error("parseSchedule accepted a scheduledAt that is not RFC3339")
	}
}

// THE new rule: a meeting cannot be put in the past. "Start now" is what an
// omitted scheduledAt already means (see the test above) — a genuinely past
// date is never a real schedule request.
func TestParseScheduleRejectsAScheduledAtWellInThePast(t *testing.T) {
	at := time.Now().Add(-24 * time.Hour)
	if _, ok := parseSchedule(scheduleCallReq{Title: "x", ScheduledAt: rfc3339(at)}); ok {
		t.Error("parseSchedule accepted a scheduledAt 24 hours in the past")
	}
}

// The grace window absorbs ordinary clock skew and the gap between a client
// picking a time and the request arriving — it must not reject a value that
// was valid the instant it was chosen.
func TestParseScheduleAcceptsAScheduledAtJustInsideTheGraceWindow(t *testing.T) {
	at := time.Now().Add(-10 * time.Second)
	if _, ok := parseSchedule(scheduleCallReq{Title: "x", ScheduledAt: rfc3339(at)}); !ok {
		t.Error("parseSchedule rejected a scheduledAt only 10s in the past")
	}
}

func TestParseScheduleRejectsBadMedia(t *testing.T) {
	if _, ok := parseSchedule(scheduleCallReq{Title: "x", Media: "holographic"}); ok {
		t.Error("parseSchedule accepted an unknown media value")
	}
}

func TestParseScheduleDefaultsMediaToVideo(t *testing.T) {
	sc, ok := parseSchedule(scheduleCallReq{Title: "x"})
	if !ok || sc.Media != "video" {
		t.Errorf("Media = %q, ok = %v, want %q, true", sc.Media, ok, "video")
	}
}

func ptr(t time.Time) *time.Time { return &t }
func intPtr(n int) *int          { return &n }
