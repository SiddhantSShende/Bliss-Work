package store

// The authorization boundary of repeating meetings, on every path that takes an id from
// the caller: creating, editing, reading and cancelling. Each refusal must be the
// repository's one answer (ErrForbidden — the same for "no such thing", "another org's"
// and "not yours", so nobody can probe), and a refused edit or cancel must change nothing.
// See meeting_series_helpers_db_test.go for how to run these.

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// A person or channel the organiser is not entitled to invite, arranged in each of the
// ways that can be so, and tried through BOTH ways of naming them: creating a series and
// editing one.
func TestSeriesAuthz_UninvitablePeopleAndChannelsAreRefusedOnCreateAndEdit(t *testing.T) {
	ctx := context.Background()
	f := newReconcileFixture(t, dailyRule())
	s, org, host := f.s, f.org, f.host

	otherOrg := newOrg()
	stranger := seedPeople(t, s, otherOrg, 1)[0]
	foreignChannel := newChannel(t, s, otherOrg, stranger)
	privateChannel := newChannel(t, s, org, f.a, f.b) // the organiser is not in it
	deletedChannel := newChannel(t, s, org, host, f.a)
	bypassExec(t, s, `DELETE FROM channels WHERE id = $1`, deletedChannel) // members outlive it
	inactive := seedPeople(t, s, org, 1)[0]
	if err := s.SetUserActive(ctx, inactive, false); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	blocksHost := seedPeople(t, s, org, 1)[0]
	blockedByHost := seedPeople(t, s, org, 1)[0]
	feud1, feud2 := seedPeople(t, s, org, 1)[0], seedPeople(t, s, org, 1)[0]
	for _, b := range [][2]string{{blocksHost, host}, {host, blockedByHost}, {feud1, feud2}} {
		if err := s.Block(ctx, org, b[0], b[1]); err != nil {
			t.Fatalf("Block: %v", err)
		}
	}

	cases := []struct {
		name     string
		invitees []string
		channels []string
	}{
		{"1. a channel the organiser is not a member of", nil, []string{privateChannel}},
		{"2. a deleted channel", nil, []string{deletedChannel}},
		{"2b. a channel that never existed", nil, []string{uuid.NewString()}},
		{"3. a deleted member (an id nobody holds)", []string{uuid.NewString()}, nil},
		{"4. an inactive member", []string{inactive}, nil},
		{"5a. a member who has blocked the organiser", []string{blocksHost}, nil},
		{"5b. a member the organiser has blocked", []string{blockedByHost}, nil},
		{"5c. two members who have blocked each other", []string{feud1, feud2}, nil},
		{"9a. another organisation's member", []string{stranger}, nil},
		{"9b. another organisation's channel", nil, []string{foreignChannel}},
		{"a good member alongside a bad one", []string{f.b, inactive}, nil},
	}
	rule := weeklyRule(1, 0)
	start := nextLocal(time.UTC, time.Monday, 8)

	for _, c := range cases {
		t.Run(c.name+"/create", func(t *testing.T) {
			before := bypassCount(t, s, `SELECT count(*) FROM call_series WHERE org_id = $1`, org)
			_, err := meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC",
				invitees: c.invitees, channels: c.channels}.tryScheduling(s)
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("err = %v, want ErrForbidden", err)
			}
			if after := bypassCount(t, s, `SELECT count(*) FROM call_series WHERE org_id = $1`, org); after != before {
				t.Errorf("a refused create left a series behind (%d -> %d)", before, after)
			}
		})
		t.Run(c.name+"/edit", func(t *testing.T) {
			before := f.snapshot(t)
			// Both ways of naming them: only members, only channels.
			patch := SeriesPatch{}
			if c.invitees != nil {
				ids := c.invitees
				patch.InviteeIDs = &ids
			}
			if c.channels != nil {
				ids := c.channels
				patch.ChannelIDs = &ids
			}
			title := "must not stick"
			patch.Title = &title
			if _, err := s.UpdateSeries(ctx, org, host, f.id(), patch); !errors.Is(err, ErrForbidden) {
				t.Fatalf("err = %v, want ErrForbidden", err)
			}
			after := f.snapshot(t)
			if len(after) != len(before) {
				t.Fatalf("a refused edit changed the occurrence count: %d -> %d", len(before), len(after))
			}
			for id, b := range before {
				if a := after[id]; a.title != b.title || fmt.Sprint(a.roster) != fmt.Sprint(b.roster) {
					t.Errorf("a refused edit changed occurrence %s", id)
				}
			}
			if _, in := after[f.linkCall].roster[f.guest]; !in {
				t.Error("a refused edit removed a link guest")
			}
		})
	}
}

// Reading, changing and cancelling a series: the organiser alone, whoever else is on
// the meeting, in the org, or from outside it — and a refusal changes nothing.
func TestSeriesAuthz_OnlyTheOrganiserMayReadChangeOrCancelAndARefusalChangesNothing(t *testing.T) {
	ctx := context.Background()
	f := newReconcileFixture(t, dailyRule())
	s := f.s
	before := f.snapshot(t)

	rival := seedPeople(t, s, f.org, 1)[0] // same org, organises a series of their own
	rule := dailyRule()
	rivalSeries := meetingIn{orgID: f.org, host: rival, start: nextLocal(time.UTC, time.Monday, 9), rule: &rule, zone: "UTC"}.schedule(t, s)
	outsideOrg := newOrg()
	outsider := seedPeople(t, s, outsideOrg, 1)[0]

	title := "hijack"
	empty := []string{}
	for name, who := range map[string]struct{ org, user string }{
		"an invitee on the roster":         {f.org, f.a},
		"a colleague not invited":          {f.org, f.b},
		"the organiser of another series":  {f.org, rival},
		"a guest who joined by link":       {f.guestOrg, f.guest},
		"a member of another organisation": {outsideOrg, outsider},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := s.GetSeries(ctx, who.org, who.user, f.id()); !errors.Is(err, ErrForbidden) {
				t.Errorf("GetSeries = %v, want ErrForbidden", err)
			}
			if _, err := s.UpdateSeries(ctx, who.org, who.user, f.id(), SeriesPatch{Title: &title, InviteeIDs: &empty}); !errors.Is(err, ErrForbidden) {
				t.Errorf("UpdateSeries = %v, want ErrForbidden", err)
			}
			if _, err := s.CancelSeries(ctx, who.org, who.user, f.id()); !errors.Is(err, ErrForbidden) {
				t.Errorf("CancelSeries = %v, want ErrForbidden", err)
			}
		})
	}
	// Somebody else's series id, presented with your own org and identity — the shape of
	// an id-substitution attack — is the same refusal as an id that does not exist.
	if _, err := s.GetSeries(ctx, outsideOrg, outsider, rivalSeries.Series.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("another org's series id = %v, want ErrForbidden", err)
	}
	if _, err := s.GetSeries(ctx, f.org, f.host, uuid.NewString()); !errors.Is(err, ErrForbidden) {
		t.Errorf("an unknown series id = %v, want the same ErrForbidden", err)
	}

	after := f.snapshot(t)
	if len(after) != len(before) {
		t.Fatalf("refused requests changed the occurrence count: %d -> %d", len(before), len(after))
	}
	for id, b := range before {
		if a := after[id]; a.status != b.status || a.title != b.title || fmt.Sprint(a.roster) != fmt.Sprint(b.roster) {
			t.Errorf("a refused request changed occurrence %s", id)
		}
	}
	got, _ := s.GetSeries(ctx, f.org, f.host, f.id())
	if got.Status != SeriesActive || got.Title != "Team sync" {
		t.Errorf("the series changed under refused requests: %+v", got)
	}
}

// A cancelled series cannot be brought back by editing it, and cancelling does not
// depend on who else tries at the same time.
func TestSeriesAuthz_ACancelledSeriesStaysCancelled(t *testing.T) {
	ctx := context.Background()
	f := newReconcileFixture(t, dailyRule())
	if _, err := f.s.CancelSeries(ctx, f.org, f.host, f.id()); err != nil {
		t.Fatalf("CancelSeries: %v", err)
	}
	title := "zombie"
	if _, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), SeriesPatch{Title: &title,
		Recurrence: &RecurrenceInput{Rule: dailyRule(), TimeZone: "UTC"}}); !errors.Is(err, ErrSeriesCancelled) {
		t.Fatalf("editing a cancelled series = %v, want ErrSeriesCancelled", err)
	}
	if n, err := f.s.TopUpDueSeries(ctx, 100); err != nil || n != 0 {
		t.Errorf("a sweep advanced %d series (err %v)", n, err)
	}
	if n := bypassCount(t, f.s, `SELECT count(*) FROM calls WHERE series_id = $1 AND status = 'SCHEDULED'`, f.id()); n != 0 {
		t.Errorf("%d upcoming occurrences on a cancelled series", n)
	}
}

// A new series' recurrence is validated before anything is written.
func TestSeriesAuthz_AnInvalidRecurrenceOnEditChangesNothing(t *testing.T) {
	ctx := context.Background()
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)
	for name, rule := range map[string]recurrence.Rule{
		"weekly with no weekday": weeklyRule(1),
		"interval zero":          {Frequency: recurrence.Daily, Interval: 0, EndCondition: recurrence.EndNever},
		"end before the start":   {Frequency: recurrence.Daily, Interval: 1, EndCondition: recurrence.EndOnDate, EndDate: "2001-01-01"},
		"count of zero":          {Frequency: recurrence.Daily, Interval: 1, EndCondition: recurrence.EndAfterCount},
	} {
		if _, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), SeriesPatch{Recurrence: &RecurrenceInput{Rule: rule}}); !errors.Is(err, recurrence.ErrInvalid) {
			t.Errorf("%s: err = %v, want recurrence.ErrInvalid", name, err)
		}
	}
	if _, err := f.s.UpdateSeries(ctx, f.org, f.host, f.id(), SeriesPatch{Recurrence: &RecurrenceInput{Rule: dailyRule(), TimeZone: "Mars/Base"}}); !errors.Is(err, recurrence.ErrInvalid) {
		t.Errorf("an unknown time zone: err = %v", err)
	}
	after := f.snapshot(t)
	if len(after) != len(before) {
		t.Fatalf("refused edits changed the occurrence count: %d -> %d", len(before), len(after))
	}
	for id := range before {
		if _, ok := after[id]; !ok {
			t.Errorf("occurrence %s vanished under a refused edit", id)
		}
	}
}
