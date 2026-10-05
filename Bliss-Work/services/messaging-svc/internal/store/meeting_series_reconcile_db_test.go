package store

// Editing a series RECONCILES its upcoming occurrences; it does not rewrite them.
// What that protects — occurrence ids, join links, link-guests, manual additions,
// history — is what these tests exist to pin down. See
// meeting_series_helpers_db_test.go for how to run them.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// reconcileFixture is a series with a past, a present and a future that each carry
// something an edit must not lose.
type reconcileFixture struct {
	s               *Store
	org, host       string
	a, b, c, manual string
	guestOrg, guest string
	start           time.Time
	rule            recurrence.Rule
	call            *CallDTO
	rows            []storedOccurrence
	linkCall        string // an occurrence with a join link a guest has redeemed
	linkToken       string
	manualCall      string // an occurrence a participant added somebody to by hand
	endedID, liveID string // the history: over, and started
}

// newReconcileFixture makes a series whose first occurrence is over and whose second
// is live, with a redeemed join link on one Monday and a hand-added participant on
// another.
func newReconcileFixture(t *testing.T, rule recurrence.Rule) reconcileFixture {
	t.Helper()
	s := lifecycleStore(t)
	ctx := context.Background()
	org, guestOrg := newOrg(), newOrg()
	p := seedPeople(t, s, org, 5)
	f := reconcileFixture{s: s, org: org, host: p[0], a: p[1], b: p[2], c: p[3], manual: p[4],
		guestOrg: guestOrg, guest: seedPeople(t, s, guestOrg, 1)[0], rule: rule}
	f.start = nextLocal(time.UTC, time.Monday, 9)
	f.call = meetingIn{orgID: org, host: f.host, start: f.start, rule: &rule, zone: "UTC", invitees: []string{f.a}}.schedule(t, s)
	f.rows = occurrencesOf(t, s, f.call.Series.ID)
	var mondays []int
	for i, r := range f.rows {
		if r.at.Weekday() == time.Monday {
			mondays = append(mondays, i)
		}
	}
	if len(f.rows) < 10 || len(mondays) < 3 {
		t.Fatalf("fixture needs 10+ occurrences and 3+ Mondays, has %d and %d", len(f.rows), len(mondays))
	}

	f.endedID, f.liveID = f.rows[0].id, f.rows[1].id
	bypassExec(t, s, `UPDATE calls SET status = 'ENDED', ended_at = now() WHERE id = $1`, f.endedID)
	bypassExec(t, s, `UPDATE calls SET status = 'LIVE', started_at = now() WHERE id = $1`, f.liveID)

	// The second and third Mondays: edits that keep Mondays keep them, and edits
	// that drop Mondays visibly lose them.
	f.linkCall = f.rows[mondays[1]].id
	inv, err := s.CreateInvite(ctx, org, f.host, f.linkCall, 24*time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	f.linkToken = inv.Token
	if _, err := s.RedeemInvite(ctx, guestOrg, f.guest, f.linkToken); err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}

	f.manualCall = f.rows[mondays[2]].id
	if err := s.AddParticipant(ctx, org, f.host, f.manualCall, f.manual); err != nil {
		t.Fatalf("AddParticipant: %v", err)
	}
	return f
}

func (f reconcileFixture) id() string { return f.call.Series.ID }

// orphans counts roster and link rows whose meeting no longer exists — what a careless
// removal leaves behind.
func (f reconcileFixture) orphans(t *testing.T) int {
	t.Helper()
	return bypassCount(t, f.s, `SELECT
		(SELECT count(*) FROM call_participants cp WHERE NOT EXISTS (SELECT 1 FROM calls c WHERE c.id = cp.call_id)) +
		(SELECT count(*) FROM call_invites ci WHERE NOT EXISTS (SELECT 1 FROM calls c WHERE c.id = ci.call_id))`)
}

func (f reconcileFixture) edit(t *testing.T, p SeriesPatch) *SeriesChange {
	t.Helper()
	orphansBefore := f.orphans(t)
	ch, err := f.s.UpdateSeries(context.Background(), f.org, f.host, f.id(), p)
	if err != nil {
		t.Fatalf("UpdateSeries: %v", err)
	}
	f.assertInvariants(t)
	if after := f.orphans(t); after != orphansBefore {
		t.Errorf("an edit left %d orphaned roster/link rows behind", after-orphansBefore)
	}
	return ch
}

// state is one occurrence as an edit could have changed it.
type state struct {
	id, status, title string
	at                time.Time
	roster            map[string]string
}

func (f reconcileFixture) snapshot(t *testing.T) map[string]state {
	t.Helper()
	out := map[string]state{}
	ctx := context.Background()
	for _, o := range occurrencesOf(t, f.s, f.id()) {
		c, err := f.s.GetCall(ctx, f.org, f.host, o.id)
		if err != nil {
			t.Fatalf("GetCall %s: %v", o.id, err)
		}
		out[o.id] = state{id: o.id, status: o.status, at: o.at, title: c.Title, roster: rosterOf(t, f.s, o.id)}
	}
	return out
}

func (f reconcileFixture) atToID(m map[string]state) map[int64]string {
	out := map[int64]string{}
	for id, st := range m {
		out[st.at.Unix()] = id
	}
	return out
}

// assertHistoryUntouched: started and ended occurrences are exactly as they were.
func (f reconcileFixture) assertHistoryUntouched(t *testing.T, before, after map[string]state) {
	t.Helper()
	for _, id := range []string{f.endedID, f.liveID} {
		b, a := before[id], after[id]
		if a.id == "" {
			t.Errorf("history occurrence %s (%s) was removed", id, b.status)
			continue
		}
		if a.status != b.status || a.title != b.title || !a.at.Equal(b.at) || fmt.Sprint(a.roster) != fmt.Sprint(b.roster) {
			t.Errorf("history occurrence %s changed:\n before %+v\n after  %+v", id, b, a)
		}
	}
}

// assertInvariants: whatever an edit did, the series is internally consistent and
// nothing is booked twice.
func (f reconcileFixture) assertInvariants(t *testing.T) {
	t.Helper()
	rows := occurrencesOf(t, f.s, f.id())
	seen := map[int64]bool{}
	for _, r := range rows {
		if seen[r.at.Unix()] {
			t.Errorf("two occurrences at %v", r.at)
		}
		seen[r.at.Unix()] = true
	}
	got, err := f.s.GetSeries(context.Background(), f.org, f.host, f.id())
	if err != nil {
		t.Fatalf("GetSeries: %v", err)
	}
	if got.OccurrenceCount != len(rows) {
		t.Errorf("series says %d occurrences, there are %d", got.OccurrenceCount, len(rows))
	}
	if (got.NextStartAt == nil) != (got.Status == SeriesCompleted) {
		t.Errorf("status %s with nextStartAt %v", got.Status, got.NextStartAt)
	}
	if got.NextStartAt != nil {
		next, _ := time.Parse(time.RFC3339, *got.NextStartAt)
		if !rows[len(rows)-1].at.Before(next) {
			t.Errorf("cursor %v is not after the last occurrence %v", next, rows[len(rows)-1].at)
		}
	}
	if !sort.SliceIsSorted(rows, func(i, j int) bool { return rows[i].at.Before(rows[j].at) }) {
		t.Error("occurrences are not in time order")
	}
}

// expectedUpcoming works out, from the schedule alone, which instants a series
// should hold after an edit: every one after now, in order, that is not already
// taken by a settled occurrence, until the end condition or the horizon.
func expectedUpcoming(t *testing.T, rule recurrence.Rule, start time.Time, zone string, settled map[int64]bool) map[int64]bool {
	t.Helper()
	sched, err := recurrence.New(rule, start, zone)
	if err != nil {
		t.Fatalf("recurrence.New: %v", err)
	}
	now := time.Now().UTC()
	horizon := now.Add(SeriesHorizon)
	out := map[int64]bool{}
	cur, ok := sched.After(now)
	for ok && len(out) < seriesBatchLimit {
		if cur.After(horizon) && len(out) > 0 {
			break
		}
		if !settled[cur.Unix()] {
			if !sched.Allows(cur, len(settled)+len(out)) {
				break
			}
			out[cur.Unix()] = true
		}
		cur, ok = sched.After(cur)
	}
	return out
}

func settledInstants(m map[string]state) map[int64]bool {
	out := map[int64]bool{}
	for _, st := range m {
		if st.status != CallScheduled || !st.at.After(time.Now().UTC()) {
			out[st.at.Unix()] = true
		}
	}
	return out
}

func instantsOf(m map[string]state) map[int64]bool {
	out := map[int64]bool{}
	for _, st := range m {
		out[st.at.Unix()] = true
	}
	return out
}

func sameInstants(a, b map[int64]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

// ── The headline: an edit that does not move an occurrence must not touch it ────

// Fixing a typo in the title used to delete every upcoming occurrence and write it
// again under a new id — which silently killed every join link already sent, threw
// out every guest who had arrived by one, and lost anyone added by hand.
func TestMeetingSeriesReconcile_ATitleEditKeepsEveryOccurrenceItsLinkAndItsGuest(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)

	title := "Renamed"
	change := f.edit(t, SeriesPatch{Title: &title})

	after := f.snapshot(t)
	if !sameInstants(instantsOf(before), instantsOf(after)) {
		t.Fatal("the set of occurrence instants changed on a title edit")
	}
	for id := range before {
		if _, ok := after[id]; !ok {
			t.Errorf("occurrence %s got a new id or vanished", id)
		}
	}
	for id, st := range after {
		if before[id].status == CallScheduled && st.title != "Renamed" {
			t.Errorf("upcoming occurrence %s still called %q", id, st.title)
		}
	}
	f.assertHistoryUntouched(t, before, after)

	// The link still opens the meeting it always did, for a NEW guest as well.
	other := seedPeople(t, f.s, newOrg(), 1)[0]
	if _, err := f.s.RedeemInvite(context.Background(), f.guestOrg, other, f.linkToken); err != nil {
		t.Errorf("the join link stopped working after an edit: %v", err)
	}
	if _, in := after[f.linkCall].roster[f.guest]; !in {
		t.Error("the guest who arrived by link was thrown out")
	}
	if _, in := after[f.manualCall].roster[f.manual]; !in {
		t.Error("the person added by hand was thrown out")
	}
	if change.Call == nil || change.Recipients != nil {
		t.Errorf("a title change is announced to everyone: call=%v recipients=%v", change.Call, change.Recipients)
	}
}

func TestMeetingSeriesReconcile_ANoOpEditChangesNothingAndAnnouncesNothing(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)
	series, _ := f.s.GetSeries(context.Background(), f.org, f.host, f.id())

	same := series.Title
	invitees, channels := series.InviteeIDs, series.ChannelIDs
	change := f.edit(t, SeriesPatch{Title: &same, InviteeIDs: &invitees, ChannelIDs: &channels,
		Recurrence: &RecurrenceInput{Rule: f.rule, TimeZone: "UTC"}})

	after := f.snapshot(t)
	if len(before) != len(after) {
		t.Fatalf("%d occurrences became %d", len(before), len(after))
	}
	for id, b := range before {
		if a := after[id]; a.status != b.status || a.title != b.title || fmt.Sprint(a.roster) != fmt.Sprint(b.roster) {
			t.Errorf("occurrence %s changed on a no-op edit", id)
		}
	}
	if change.Call != nil {
		t.Errorf("a no-op edit announced %v", change.Call.ID)
	}
}

// ── People ─────────────────────────────────────────────────────────────────────

func TestMeetingSeriesReconcile_ChangingMembersAddsAndRemovesOnlyWhatTheSeriesSeated(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)

	people := []string{f.b} // a out, b in
	change := f.edit(t, SeriesPatch{InviteeIDs: &people})

	after := f.snapshot(t)
	if !sameInstants(instantsOf(before), instantsOf(after)) {
		t.Fatal("changing members moved occurrences")
	}
	for id, st := range after {
		if before[id].status != CallScheduled {
			continue
		}
		if _, has := st.roster[f.b]; !has {
			t.Errorf("%s is not on the new member's meeting %s", f.b, id)
		}
		if _, has := st.roster[f.a]; has {
			t.Errorf("the removed member is still on %s", id)
		}
		if st.roster[f.host] != RoleHost {
			t.Errorf("the organiser lost HOST on %s", id)
		}
	}
	// Never the guest, and never the person somebody added by hand.
	if _, in := after[f.linkCall].roster[f.guest]; !in {
		t.Error("a link guest was removed by a member edit")
	}
	if _, in := after[f.manualCall].roster[f.manual]; !in {
		t.Error("a hand-added participant was removed by a member edit")
	}
	f.assertHistoryUntouched(t, before, after)
	// History still shows the member who WAS on it.
	if _, in := after[f.endedID].roster[f.a]; !in {
		t.Error("history was rewritten: the removed member vanished from a meeting that already happened")
	}
	// Only the newly invited hear about it.
	if change.Recipients == nil || len(change.Recipients) != 1 || change.Recipients[0] != f.b {
		t.Errorf("recipients = %v, want only the newly added member", change.Recipients)
	}
}

func TestMeetingSeriesReconcile_ChangingChannelsFollowsTheChannelsMembers(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	ch := newChannel(t, f.s, f.org, f.host, f.b, f.c)
	before := f.snapshot(t)

	channels := []string{ch}
	change := f.edit(t, SeriesPatch{ChannelIDs: &channels})
	after := f.snapshot(t)
	for id, st := range after {
		if before[id].status != CallScheduled {
			continue
		}
		for _, u := range []string{f.a, f.b, f.c} {
			if _, has := st.roster[u]; !has {
				t.Errorf("%s missing from %s after adding their channel", u, id)
			}
		}
	}
	got, _ := f.s.GetCall(context.Background(), f.org, f.host, f.rows[10].id)
	if len(got.ChannelIDs) != 1 || got.ChannelIDs[0] != ch {
		t.Errorf("channelIds on an existing occurrence = %v", got.ChannelIDs)
	}
	seen := map[string]int{}
	for _, r := range change.Recipients {
		seen[r]++
	}
	if len(seen) != 2 || seen[f.b] != 1 || seen[f.c] != 1 {
		t.Errorf("recipients = %v, want exactly b and c, once each", change.Recipients)
	}

	// Taking the channel away removes the people IT brought, and only them.
	none := []string{}
	f.edit(t, SeriesPatch{ChannelIDs: &none})
	final := f.snapshot(t)
	for id, st := range final {
		if before[id].status != CallScheduled {
			continue
		}
		if _, has := st.roster[f.b]; has {
			t.Errorf("channel member still on %s after the channel was removed", id)
		}
		if _, has := st.roster[f.a]; !has {
			t.Errorf("the picked member was removed along with the channel on %s", id)
		}
	}
	if _, in := final[f.manualCall].roster[f.manual]; !in {
		t.Error("a hand-added participant was removed when a channel was")
	}
}

// A member added to a series is not put in a room with somebody they have a block
// with — even when that somebody was added by hand, a person the series did not
// choose and so did not check.
func TestMeetingSeriesReconcile_ANewMemberIsNotSeatedWithSomeoneTheyHaveABlockWith(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	if err := f.s.Block(context.Background(), f.org, f.b, f.manual); err != nil {
		t.Fatalf("Block: %v", err)
	}
	people := []string{f.a, f.b}
	f.edit(t, SeriesPatch{InviteeIDs: &people})

	after := f.snapshot(t)
	if _, in := after[f.manualCall].roster[f.b]; in {
		t.Error("a member was seated with the hand-added participant they have blocked")
	}
	if _, in := after[f.rows[9].id].roster[f.b]; !in {
		t.Error("the same member was left off an occurrence with no conflict")
	}
}

// ── Schedule ───────────────────────────────────────────────────────────────────

// checkSchedule asserts an edit produced exactly the schedule's instants, and that
// every occurrence whose instant survived kept its id.
func (f reconcileFixture) checkSchedule(t *testing.T, before map[string]state, rule recurrence.Rule) map[string]state {
	t.Helper()
	after := f.snapshot(t)
	want := expectedUpcoming(t, rule, f.start, "UTC", settledInstants(before))
	got := map[int64]bool{}
	for _, st := range after {
		if st.status == CallScheduled && st.at.After(time.Now().UTC()) {
			got[st.at.Unix()] = true
		}
	}
	if !sameInstants(want, got) {
		t.Errorf("upcoming instants differ from the schedule:\n want %d, got %d", len(want), len(got))
	}
	beforeAt := f.atToID(before)
	afterAt := f.atToID(after)
	for at, id := range beforeAt {
		if before[id].status != CallScheduled {
			continue
		}
		newID, still := afterAt[at]
		switch {
		case want[at] && !still:
			t.Errorf("instant %v is still scheduled but its occurrence vanished", time.Unix(at, 0).UTC())
		case want[at] && newID != id:
			t.Errorf("instant %v survived the edit but its occurrence id changed", time.Unix(at, 0).UTC())
		case !want[at] && still:
			t.Errorf("instant %v is no longer in the schedule but was kept", time.Unix(at, 0).UTC())
		}
	}
	f.assertHistoryUntouched(t, before, after)
	return after
}

func TestMeetingSeriesReconcile_ChangingTheFrequencyKeepsTheInstantsThatSurvive(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)

	weeklyMonday := weeklyRule(1, 0)
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: weeklyMonday, TimeZone: "UTC"}})
	after := f.checkSchedule(t, before, weeklyMonday)

	// Mondays survive with everything on them: the redeemed link, the guest, the
	// hand-added person. Every other day is gone, and so is what was on it.
	if _, ok := after[f.linkCall]; !ok || after[f.linkCall].roster[f.guest] == "" {
		t.Error("the Monday with the guest and its link did not survive a daily->weekly edit")
	}
	if _, ok := after[f.manualCall]; !ok {
		t.Error("the Monday with the hand-added person did not survive")
	}
	for id, st := range after {
		if st.status == CallScheduled && st.at.Weekday() != time.Monday {
			t.Errorf("%s survived on a %s", id, st.at.Weekday())
		}
	}
}

// A link is for a MEETING. When that meeting leaves the schedule the link dies with it —
// cleanly (the same refusal as any dead link), leaving no roster or link rows behind — and
// the ones still on the schedule are untouched.
func TestMeetingSeriesReconcile_ALinkToAMeetingThatLeftTheScheduleStopsWorking(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	onTuesdays := weeklyRule(1, 1) // the link is on a Monday, so it goes
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: onTuesdays, TimeZone: "UTC"}})

	late := seedPeople(t, f.s, newOrg(), 1)[0]
	if _, err := f.s.RedeemInvite(context.Background(), f.guestOrg, late, f.linkToken); !errors.Is(err, ErrInviteInvalid) {
		t.Errorf("redeeming the link of a removed meeting = %v, want ErrInviteInvalid", err)
	}
	if n := bypassCount(t, f.s, `SELECT count(*) FROM calls WHERE id = $1`, f.linkCall); n != 0 {
		t.Error("the meeting the link pointed at still exists")
	}
	// A meeting that DID stay keeps a working link: mint one now and use it after another edit.
	rows := occurrencesOf(t, f.s, f.id())
	var stay string
	for _, r := range rows {
		if r.status == CallScheduled && r.at.After(time.Now().UTC()) {
			stay = r.id
			break
		}
	}
	inv, err := f.s.CreateInvite(context.Background(), f.org, f.host, stay, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	title := "another edit"
	f.edit(t, SeriesPatch{Title: &title})
	if _, err := f.s.RedeemInvite(context.Background(), f.guestOrg, late, inv.Token); err != nil {
		t.Errorf("the link of a meeting that stayed stopped working: %v", err)
	}
}

func TestMeetingSeriesReconcile_ChangingWeekdays(t *testing.T) {
	t.Run("dropping Friday keeps every Monday and Wednesday", func(t *testing.T) {
		f := newReconcileFixture(t, weeklyRule(1, 0, 2, 4))
		before := f.snapshot(t)
		mw := weeklyRule(1, 0, 2)
		f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: mw, TimeZone: "UTC"}})
		f.checkSchedule(t, before, mw)
	})
	t.Run("Tuesday and Thursday instead replaces them all, and is still exact", func(t *testing.T) {
		f := newReconcileFixture(t, weeklyRule(1, 0, 2, 4))
		before := f.snapshot(t)
		tt := weeklyRule(1, 1, 3)
		f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: tt, TimeZone: "UTC"}})
		after := f.checkSchedule(t, before, tt)
		for _, st := range after {
			if st.status == CallScheduled && st.at.Weekday() != time.Tuesday && st.at.Weekday() != time.Thursday {
				t.Errorf("an occurrence on a %s", st.at.Weekday())
			}
		}
	})
	t.Run("adding a day keeps everything and adds only the new day", func(t *testing.T) {
		f := newReconcileFixture(t, weeklyRule(1, 0, 2))
		before := f.snapshot(t)
		mwf := weeklyRule(1, 0, 2, 4)
		f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: mwf, TimeZone: "UTC"}})
		after := f.checkSchedule(t, before, mwf)
		for id := range before {
			if _, ok := after[id]; !ok {
				t.Errorf("adding Friday removed occurrence %s", id)
			}
		}
	})
}

func TestMeetingSeriesReconcile_ChangingTheInterval(t *testing.T) {
	f := newReconcileFixture(t, weeklyRule(1, 0, 2, 4))
	before := f.snapshot(t)
	every2 := weeklyRule(2, 0, 2, 4)
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: every2, TimeZone: "UTC"}})
	after := f.checkSchedule(t, before, every2)
	// Weeks are counted from the anchor's Monday, so every other week goes.
	for _, st := range after {
		if st.status != CallScheduled {
			continue
		}
		week := int(st.at.Sub(f.start.AddDate(0, 0, -int(f.start.Weekday()-time.Monday))) / (7 * 24 * time.Hour))
		if week%2 != 0 {
			t.Errorf("an occurrence in week %d of an every-2-weeks series", week)
		}
	}
}

func TestMeetingSeriesReconcile_ChangingTheEndDate(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)

	shorter := dailyRule()
	shorter.EndCondition, shorter.EndDate = recurrence.EndOnDate, f.start.AddDate(0, 0, 20).Format("2006-01-02")
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: shorter, TimeZone: "UTC"}})
	mid := f.checkSchedule(t, before, shorter)
	for _, st := range mid {
		if st.at.Format("2006-01-02") > shorter.EndDate {
			t.Errorf("an occurrence on %v is past the end date %s", st.at, shorter.EndDate)
		}
	}
	got, _ := f.s.GetSeries(context.Background(), f.org, f.host, f.id())
	if got.Status != SeriesCompleted {
		t.Errorf("status = %s after ending inside the horizon", got.Status)
	}

	// And back out: the survivors keep their ids, the rest are written again.
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: dailyRule(), TimeZone: "UTC"}})
	back := f.snapshot(t)
	for id := range mid {
		if _, ok := back[id]; !ok {
			t.Errorf("extending the end removed occurrence %s", id)
		}
	}
}

func TestMeetingSeriesReconcile_ChangingTheOccurrenceCountCountsHistory(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)

	// Two occurrences have happened or begun; "after 6" leaves four to come.
	six := dailyRule()
	six.EndCondition, six.OccurrenceCount = recurrence.EndAfterCount, 6
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: six, TimeZone: "UTC"}})
	after := f.checkSchedule(t, before, six)
	if len(after) != 6 {
		t.Errorf("%d occurrences in total, want 6 (2 history + 4 upcoming)", len(after))
	}
	// Raising it writes only the difference.
	ten := six
	ten.OccurrenceCount = 10
	f.edit(t, SeriesPatch{Recurrence: &RecurrenceInput{Rule: ten, TimeZone: "UTC"}})
	if n := len(f.snapshot(t)); n != 10 {
		t.Errorf("%d occurrences after raising the count to 10", n)
	}
}

// Somebody who starts a meeting early leaves the ones BEFORE it still upcoming. The
// old edit deleted those and never wrote them again, because it restarted from the
// last occurrence in the table.
func TestMeetingSeriesReconcile_AnOccurrenceStartedEarlyDoesNotCostTheOnesBeforeIt(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	bypassExec(t, f.s, `UPDATE calls SET status = 'LIVE', started_at = now() WHERE id = $1`, f.rows[6].id)
	before := f.snapshot(t)

	title := "After an early start"
	f.edit(t, SeriesPatch{Title: &title})
	after := f.snapshot(t)
	for _, i := range []int{2, 3, 4, 5} {
		if _, ok := after[f.rows[i].id]; !ok {
			t.Errorf("upcoming occurrence %d, before the one that started early, was lost", i)
		}
	}
	f.assertHistoryUntouched(t, before, after)
	if after[f.rows[6].id].status != CallLive {
		t.Error("the occurrence that started early was disturbed")
	}
}

// An edit the schedule cannot satisfy changes nothing — including the people.
func TestMeetingSeriesReconcile_ARefusedEditChangesNothing(t *testing.T) {
	f := newReconcileFixture(t, dailyRule())
	before := f.snapshot(t)
	people := []string{f.b}
	title := "should not stick"
	spent := dailyRule()
	spent.EndCondition, spent.OccurrenceCount = recurrence.EndAfterCount, 2 // both already held
	_, err := f.s.UpdateSeries(context.Background(), f.org, f.host, f.id(),
		SeriesPatch{Title: &title, InviteeIDs: &people, Recurrence: &RecurrenceInput{Rule: spent, TimeZone: "UTC"}})
	if err == nil {
		t.Fatal("an edit that leaves nothing upcoming was accepted")
	}
	after := f.snapshot(t)
	if len(after) != len(before) {
		t.Fatalf("a refused edit changed the number of occurrences: %d -> %d", len(before), len(after))
	}
	for id, b := range before {
		if a := after[id]; a.title != b.title || fmt.Sprint(a.roster) != fmt.Sprint(b.roster) {
			t.Errorf("a refused edit changed occurrence %s", id)
		}
	}
}
