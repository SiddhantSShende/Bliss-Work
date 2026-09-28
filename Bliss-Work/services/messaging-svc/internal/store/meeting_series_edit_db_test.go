package store

// Changing and cancelling a repeating meeting. See
// meeting_series_helpers_db_test.go for how to run these.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// seriesFixture is a weekly Mon/Wed/Fri series with one invitee, plus the people
// an edit will bring in.
type seriesFixture struct {
	s                  *Store
	org, host          string
	a, b, c            string
	start              time.Time
	series             *CallDTO
	upcomingBeforeEdit []storedOccurrence
}

func newSeriesFixture(t *testing.T) seriesFixture {
	t.Helper()
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 4)
	rule := weeklyRule(1, 0, 2, 4)
	start := nextLocal(time.UTC, time.Monday, 9)
	c := meetingIn{orgID: org, host: p[0], start: start, rule: &rule, zone: "UTC", invitees: []string{p[1]}}.schedule(t, s)
	return seriesFixture{s: s, org: org, host: p[0], a: p[1], b: p[2], c: p[3], start: start,
		series: c, upcomingBeforeEdit: occurrencesOf(t, s, c.Series.ID)}
}

func (f seriesFixture) id() string { return f.series.Series.ID }

func (f seriesFixture) sameOccurrencesAsBefore(t *testing.T) {
	t.Helper()
	now := occurrencesOf(t, f.s, f.id())
	if len(now) != len(f.upcomingBeforeEdit) {
		t.Fatalf("%d occurrences, was %d", len(now), len(f.upcomingBeforeEdit))
	}
	for i := range now {
		if now[i].id != f.upcomingBeforeEdit[i].id {
			t.Fatalf("occurrence %d was replaced by a refused request", i)
		}
	}
}

func strPtr(s string) *string { return &s }

// The requirement: editing a repeating meeting updates its members, channels,
// frequency, interval, weekdays and end condition — and what comes back for an
// edit form is what was saved.
func TestMeetingSeries_EditReplacesTheUpcomingOccurrencesWithTheNewShape(t *testing.T) {
	f := newSeriesFixture(t)
	ctx := context.Background()
	ch := newChannel(t, f.s, f.org, f.host, f.c)

	rule := recurrence.Rule{Frequency: recurrence.Weekly, Interval: 2, Weekdays: []int{3, 1},
		EndCondition: recurrence.EndAfterCount, OccurrenceCount: 6}
	invitees, channels := []string{f.b}, []string{ch}
	change, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), SeriesPatch{
		Title: strPtr("Renamed"), InviteeIDs: &invitees, ChannelIDs: &channels,
		Recurrence: &RecurrenceInput{Rule: rule},
	})
	if err != nil {
		t.Fatalf("UpdateSeries: %v", err)
	}

	// Saved, and read back as an edit form would.
	got, err := f.s.GetSeries(ctx, f.org, f.host, f.id())
	if err != nil {
		t.Fatalf("GetSeries: %v", err)
	}
	r := got.Recurrence
	if got.Title != "Renamed" || r.Frequency != "WEEKLY" || r.Interval != 2 || r.EndCondition != "AFTER_OCCURRENCES" ||
		r.OccurrenceCount == nil || *r.OccurrenceCount != 6 || len(r.Weekdays) != 2 || r.Weekdays[0] != 1 || r.Weekdays[1] != 3 {
		t.Errorf("series after edit = %+v", got)
	}
	if len(got.InviteeIDs) != 1 || got.InviteeIDs[0] != f.b || len(got.ChannelIDs) != 1 || got.ChannelIDs[0] != ch {
		t.Errorf("people after edit: invitees %v channels %v", got.InviteeIDs, got.ChannelIDs)
	}

	// The old upcoming occurrences are gone, replaced by exactly the new rule's.
	rows := occurrencesOf(t, f.s, f.id())
	if len(rows) != 6 {
		t.Fatalf("%d occurrences, want the 6 the new end condition allows", len(rows))
	}
	old := map[string]bool{}
	for _, o := range f.upcomingBeforeEdit {
		old[o.id] = true
	}
	want := expectedInHorizon(t, rule, f.start, "UTC", time.Now().UTC().Add(SeriesHorizon))
	for i, o := range rows {
		if old[o.id] {
			t.Errorf("occurrence %d is one of the old ones", i)
		}
		if i < len(want) && !o.at.Equal(want[i]) {
			t.Errorf("occurrence %d at %v, want %v", i, o.at, want[i])
		}
		if wd := o.at.Weekday(); wd != time.Tuesday && wd != time.Thursday {
			t.Errorf("occurrence %d is on a %s", i, wd)
		}
		wantRoster(t, rosterOf(t, f.s, o.id), f.host, f.b, f.c) // the picked member and the channel's
	}
	if change.Call == nil || change.Call.ID != rows[0].id || change.Call.Title != "Renamed" {
		t.Errorf("the notification's call = %+v, want the first new occurrence", change.Call)
	}
	if got.OccurrenceCount != 6 || got.Status != SeriesCompleted {
		t.Errorf("count/status = %d/%s", got.OccurrenceCount, got.Status)
	}
}

// Occurrences that have started or ended are history: an edit leaves them alone,
// counts them toward the end condition, and continues after them.
func TestMeetingSeries_EditKeepsHistoryAndCountsItTowardTheEnd(t *testing.T) {
	f := newSeriesFixture(t)
	ctx := context.Background()
	rows := f.upcomingBeforeEdit
	bypassExec(t, f.s, `UPDATE calls SET status = 'ENDED', ended_at = now() WHERE id = $1`, rows[0].id)
	bypassExec(t, f.s, `UPDATE calls SET status = 'LIVE', started_at = now() WHERE id = $1`, rows[1].id)

	rule := recurrence.Rule{Frequency: recurrence.Weekly, Interval: 1, Weekdays: []int{0, 2, 4},
		EndCondition: recurrence.EndAfterCount, OccurrenceCount: 5}
	if _, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), SeriesPatch{Recurrence: &RecurrenceInput{Rule: rule}}); err != nil {
		t.Fatalf("UpdateSeries: %v", err)
	}

	after := occurrencesOf(t, f.s, f.id())
	if len(after) != 5 {
		t.Fatalf("%d occurrences, want 5 in total (2 kept + 3 new)", len(after))
	}
	if after[0].id != rows[0].id || after[0].status != CallEnded || after[1].id != rows[1].id || after[1].status != CallLive {
		t.Errorf("history was disturbed: %+v", after[:2])
	}
	for i := 2; i < 5; i++ {
		if !after[i].at.After(after[1].at) {
			t.Errorf("new occurrence %d at %v is not after the last kept one", i, after[i].at)
		}
		if after[i].status != CallScheduled {
			t.Errorf("new occurrence %d is %s", i, after[i].status)
		}
	}
}

// The schedule stays where it began: an edit that changes only the people does
// not move the time of day or the rhythm.
func TestMeetingSeries_EditingOnlyThePeopleKeepsTheSchedule(t *testing.T) {
	f := newSeriesFixture(t)
	invitees := []string{f.a, f.b}
	if _, err := f.s.UpdateSeries(context.Background(), f.org, f.host, f.id(), SeriesPatch{InviteeIDs: &invitees}); err != nil {
		t.Fatalf("UpdateSeries: %v", err)
	}
	after := occurrencesOf(t, f.s, f.id())
	if len(after) != len(f.upcomingBeforeEdit) {
		t.Fatalf("%d occurrences, was %d", len(after), len(f.upcomingBeforeEdit))
	}
	for i := range after {
		if !after[i].at.Equal(f.upcomingBeforeEdit[i].at) {
			t.Errorf("occurrence %d moved from %v to %v", i, f.upcomingBeforeEdit[i].at, after[i].at)
		}
	}
	wantRoster(t, rosterOf(t, f.s, after[0].id), f.host, f.a, f.b)
}

// A refused edit changes nothing at all — not the series, not one occurrence.
func TestMeetingSeries_ARefusedEditIsAtomic(t *testing.T) {
	ctx := context.Background()
	cases := map[string]struct {
		patch func(f seriesFixture) SeriesPatch
		want  error
	}{
		"an invalid rule": {
			func(f seriesFixture) SeriesPatch {
				return SeriesPatch{Recurrence: &RecurrenceInput{Rule: weeklyRule(1)}} // no weekday
			}, recurrence.ErrInvalid,
		},
		"an invitee who cannot be invited": {
			func(f seriesFixture) SeriesPatch {
				bad := []string{f.a, newOrg()}
				return SeriesPatch{InviteeIDs: &bad}
			}, ErrForbidden,
		},
		"a channel the organiser is not in": {
			func(f seriesFixture) SeriesPatch {
				private := newChannel(t, f.s, f.org, f.a, f.b) // the organiser is not a member
				chs := []string{private}
				return SeriesPatch{ChannelIDs: &chs}
			}, ErrForbidden,
		},
		"an end date before the meeting starts": {
			func(f seriesFixture) SeriesPatch {
				r := weeklyRule(1, 0)
				r.EndCondition, r.EndDate = recurrence.EndOnDate, f.start.AddDate(0, 0, -1).Format("2006-01-02")
				return SeriesPatch{Recurrence: &RecurrenceInput{Rule: r}}
			}, recurrence.ErrInvalid,
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newSeriesFixture(t)
			title := "must not stick"
			p := c.patch(f)
			p.Title = &title
			if _, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), p); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			f.sameOccurrencesAsBefore(t)
			got, _ := f.s.GetSeries(ctx, f.org, f.host, f.id())
			if got.Title != "Team sync" {
				t.Errorf("the title changed to %q on a refused edit", got.Title)
			}
		})
	}
}

// An edit that would leave nothing upcoming is a cancellation, and says so.
func TestMeetingSeries_EditThatFinishesTheSeriesIsRefused(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	rule.EndCondition, rule.OccurrenceCount = recurrence.EndAfterCount, 3
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)
	bypassExec(t, s, `UPDATE calls SET status = 'ENDED', ended_at = now() WHERE series_id = $1`, c.Series.ID)

	title := "x"
	_, err := s.UpdateSeries(ctx, org, host, c.Series.ID, SeriesPatch{Title: &title})
	if !errors.Is(err, recurrence.ErrInvalid) {
		t.Fatalf("err = %v, want recurrence.ErrInvalid: three of three occurrences have already happened", err)
	}
}

// A series that ran out can be extended, because ending it is just a rule.
func TestMeetingSeries_ACompletedSeriesCanBeExtended(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	rule.EndCondition, rule.OccurrenceCount = recurrence.EndAfterCount, 3
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)

	longer := dailyRule()
	longer.EndCondition, longer.OccurrenceCount = recurrence.EndAfterCount, 8
	if _, err := s.UpdateSeries(ctx, org, host, c.Series.ID, SeriesPatch{Recurrence: &RecurrenceInput{Rule: longer}}); err != nil {
		t.Fatalf("UpdateSeries: %v", err)
	}
	if n := len(occurrencesOf(t, s, c.Series.ID)); n != 8 {
		t.Errorf("%d occurrences, want 8", n)
	}
}

// Only the organiser may change or cancel a series, and another org's ids answer
// exactly like a series that does not exist.
func TestMeetingSeries_OnlyTheOrganiserMayReadChangeOrCancel(t *testing.T) {
	f := newSeriesFixture(t)
	ctx := context.Background()
	outsider := seedPeople(t, f.s, newOrg(), 1)[0]
	title := "hijacked"

	for name, who := range map[string]struct{ org, user string }{
		"an invitee":           {f.org, f.a},
		"a colleague":          {f.org, f.c},
		"someone in other org": {newOrg(), outsider},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := f.s.GetSeries(ctx, who.org, who.user, f.id()); !errors.Is(err, ErrForbidden) {
				t.Errorf("GetSeries = %v", err)
			}
			if _, err := f.s.UpdateSeries(ctx, who.org, who.user, f.id(), SeriesPatch{Title: &title}); !errors.Is(err, ErrForbidden) {
				t.Errorf("UpdateSeries = %v", err)
			}
			if _, err := f.s.CancelSeries(ctx, who.org, who.user, f.id()); !errors.Is(err, ErrForbidden) {
				t.Errorf("CancelSeries = %v", err)
			}
		})
	}
	f.sameOccurrencesAsBefore(t)
	if _, err := f.s.GetSeries(ctx, f.org, f.host, "00000000-0000-4000-8000-000000000000"); !errors.Is(err, ErrForbidden) {
		t.Errorf("an unknown series = %v, want the same ErrForbidden", err)
	}
}

// Cancelling stops the series and removes what has not happened, all of it: the
// occurrences, their rosters (a guest's row from another org included) and their
// links. What has happened stays.
func TestMeetingSeries_CancelRemovesUpcomingAndKeepsHistory(t *testing.T) {
	f := newSeriesFixture(t)
	ctx := context.Background()
	rows := f.upcomingBeforeEdit
	bypassExec(t, f.s, `UPDATE calls SET status = 'ENDED', ended_at = now() WHERE id = $1`, rows[0].id)

	// A guest from another org joined the SECOND occurrence by link.
	guestOrg := newOrg()
	guest := seedPeople(t, f.s, guestOrg, 1)[0]
	inv, err := f.s.CreateInvite(ctx, f.org, f.host, rows[1].id, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := f.s.RedeemInvite(ctx, guestOrg, guest, inv.Token); err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}

	change, err := f.s.CancelSeries(ctx, f.org, f.host, f.id())
	if err != nil {
		t.Fatalf("CancelSeries: %v", err)
	}

	after := occurrencesOf(t, f.s, f.id())
	if len(after) != 1 || after[0].id != rows[0].id || after[0].status != CallEnded {
		t.Fatalf("occurrences after cancelling = %+v, want only the one that already ended", after)
	}
	removed := rows[1:]
	for _, o := range removed {
		if n := bypassCount(t, f.s, `SELECT count(*) FROM call_participants WHERE call_id = $1`, o.id); n != 0 {
			t.Errorf("%d participant rows left on a removed occurrence", n)
		}
		if n := bypassCount(t, f.s, `SELECT count(*) FROM call_invites WHERE call_id = $1`, o.id); n != 0 {
			t.Errorf("%d invite links left on a removed occurrence", n)
		}
	}
	if change.Series.Status != SeriesCancelled || change.Series.NextStartAt != nil {
		t.Errorf("series = %+v", change.Series)
	}

	// The one notification reaches everyone who was on what was removed — the
	// guest included — and describes the soonest one.
	got := map[string]bool{}
	for _, r := range change.Recipients {
		got[r] = true
	}
	for _, want := range []string{f.host, f.a, guest} {
		if !got[want] {
			t.Errorf("%s is not among the recipients %v", want, change.Recipients)
		}
	}
	if change.Call == nil || change.Call.ID != rows[1].id || change.Call.Status != CallCancelled {
		t.Errorf("notification call = %+v, want the soonest removed occurrence, CANCELLED", change.Call)
	}

	// Cancelling again is not an error and announces nothing more.
	again, err := f.s.CancelSeries(ctx, f.org, f.host, f.id())
	if err != nil || again.Call != nil {
		t.Errorf("second cancel = %+v, %v; want a quiet success", again, err)
	}
	// And nothing revives it.
	if n, err := f.s.TopUpDueSeries(ctx, 100); err != nil || n != 0 {
		t.Errorf("TopUpDueSeries revived a cancelled series: %d, %v", n, err)
	}
	if n := len(occurrencesOf(t, f.s, f.id())); n != 1 {
		t.Errorf("%d occurrences after a top-up", n)
	}
	title := "x"
	if _, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), SeriesPatch{Title: &title}); !errors.Is(err, ErrSeriesCancelled) {
		t.Errorf("editing a cancelled series = %v, want ErrSeriesCancelled", err)
	}
}

// The templates go with their org.
func TestMeetingSeries_PurgingAnOrgRemovesItsSeries(t *testing.T) {
	f := newSeriesFixture(t)
	if _, err := f.s.PurgeOrg(context.Background(), f.org); err != nil {
		t.Fatalf("PurgeOrg: %v", err)
	}
	if n := bypassCount(t, f.s, `SELECT count(*) FROM call_series WHERE org_id = $1`, f.org); n != 0 {
		t.Errorf("%d series survived the purge", n)
	}
	if n := bypassCount(t, f.s, `SELECT count(*) FROM calls WHERE series_id = $1`, f.id()); n != 0 {
		t.Errorf("%d occurrences survived the purge", n)
	}
}
