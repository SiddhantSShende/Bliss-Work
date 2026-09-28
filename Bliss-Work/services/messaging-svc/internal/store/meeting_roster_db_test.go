package store

// Who is on a meeting: the members picked one by one, and the channels whose
// members are invited. See meeting_series_helpers_db_test.go for how to run these.

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// newChannel creates a channel through the real code path, with its owner as a
// member.
func newChannel(t *testing.T, s *Store, org, owner string, members ...string) string {
	t.Helper()
	ch, err := s.CreateChannel(context.Background(), org, owner, "ch-"+uuid.NewString()[:6], false, members)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	return ch.ID
}

func wantRoster(t *testing.T, got map[string]string, host string, others ...string) {
	t.Helper()
	want := map[string]bool{host: true}
	for _, o := range others {
		want[o] = true
	}
	if len(got) != len(want) {
		t.Errorf("roster has %d people, want %d: %v", len(got), len(want), got)
	}
	for id := range want {
		if _, ok := got[id]; !ok {
			t.Errorf("%s is missing from the roster", id)
		}
	}
	if got[host] != RoleHost {
		t.Errorf("the organiser's role is %q, want HOST", got[host])
	}
	for _, o := range others {
		if got[o] != RoleParticipant {
			t.Errorf("%s has role %q, want PARTICIPANT", o, got[o])
		}
	}
}

// Members, one-off: selected members are persisted as the roster and the meeting
// behaves exactly as it always has — no channels, no series.
func TestMeetingRoster_SelectedMembersArePersistedOnAOneOff(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 4)
	host, a, b := p[0], p[1], p[2]

	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(3 * time.Hour), invitees: []string{a, b}}.schedule(t, s)

	wantRoster(t, rosterOf(t, s, c.ID), host, a, b)
	if c.Series != nil {
		t.Errorf("a one-off has a series: %+v", c.Series)
	}
	if c.ChannelIDs == nil || len(c.ChannelIDs) != 0 {
		t.Errorf("channelIds = %#v, want an empty, non-nil list", c.ChannelIDs)
	}
	if c.Status != CallScheduled || c.Kind != CallMeeting {
		t.Errorf("status/kind = %s/%s", c.Status, c.Kind)
	}
}

// "Meet now" is unchanged: LIVE at once, no series, no channels.
func TestMeetingRoster_MeetNowIsUnchanged(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	c, err := s.ScheduleMeeting(context.Background(), org, host, "now", "video", nil, nil, nil)
	if err != nil {
		t.Fatalf("ScheduleMeeting: %v", err)
	}
	if c.Status != CallLive || c.StartedAt == nil || c.ScheduledAt != nil || c.Series != nil {
		t.Errorf("meet-now = %+v", c)
	}
}

// Members, repeating: the roster is the same on every occurrence, and the picked
// members are kept apart from it so an edit form can show what was picked.
func TestMeetingRoster_SelectedMembersOnEveryOccurrenceAndRestoredForEditing(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 4)
	host, a, b := p[0], p[1], p[2]
	rule := weeklyRule(1, 0, 2, 4)

	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 9), rule: &rule,
		zone: "UTC", invitees: []string{a, b}}.schedule(t, s)

	occ := occurrencesOf(t, s, c.Series.ID)
	if len(occ) < 5 {
		t.Fatalf("only %d occurrences", len(occ))
	}
	for _, o := range occ {
		wantRoster(t, rosterOf(t, s, o.id), host, a, b)
	}
	got, err := s.GetSeries(context.Background(), org, host, c.Series.ID)
	if err != nil {
		t.Fatalf("GetSeries: %v", err)
	}
	if len(got.InviteeIDs) != 2 || got.InviteeIDs[0] != a || got.InviteeIDs[1] != b {
		t.Errorf("inviteeIds = %v, want the two picked, in order", got.InviteeIDs)
	}
}

// Repeating an id is harmless at the store (the API refuses it before it gets
// here): nobody is seated twice.
func TestMeetingRoster_ARepeatedInviteeIsSeatedOnce(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 2)
	c := meetingIn{orgID: org, host: p[0], start: time.Now().UTC().Add(time.Hour),
		invitees: []string{p[1], p[1], p[0]}}.schedule(t, s)
	wantRoster(t, rosterOf(t, s, c.ID), p[0], p[1])
}

// A member who is not there to invite: another org's, unknown, or deactivated.
// Each refuses the whole request with the SAME answer, so it cannot be used to
// learn which is which.
func TestMeetingRoster_AnInviteeWhoCannotBeInvitedRefusesTheRequest(t *testing.T) {
	s := lifecycleStore(t)
	org, other := newOrg(), newOrg()
	p := seedPeople(t, s, org, 3)
	outsider := seedPeople(t, s, other, 1)[0]
	gone := p[2]
	if err := s.SetUserActive(context.Background(), gone, false); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	start := time.Now().UTC().Add(time.Hour)
	rule := dailyRule()

	for name, invitee := range map[string]string{
		"another org": outsider,
		"unknown":     uuid.NewString(),
		"deactivated": gone,
	} {
		for _, r := range []*recurrence.Rule{nil, &rule} {
			t.Run(fmt.Sprintf("%s/repeating=%v", name, r != nil), func(t *testing.T) {
				_, err := meetingIn{orgID: org, host: p[0], start: start, rule: r, zone: "UTC",
					invitees: []string{p[1], invitee}}.tryScheduling(s)
				if !errors.Is(err, ErrForbidden) {
					t.Fatalf("err = %v, want ErrForbidden", err)
				}
			})
		}
	}
	if n := bypassCount(t, s, `SELECT count(*) FROM calls WHERE org_id = $1`, org); n != 0 {
		t.Errorf("%d calls were left behind by refused requests", n)
	}
}

// A block between two people picked by name refuses the request, on a repeating
// meeting exactly as on a one-off.
func TestMeetingRoster_ABlockedPairPickedByNameRefusesTheRequest(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 3)
	if err := s.Block(context.Background(), org, p[1], p[2]); err != nil {
		t.Fatalf("Block: %v", err)
	}
	rule := dailyRule()
	for _, r := range []*recurrence.Rule{nil, &rule} {
		_, err := meetingIn{orgID: org, host: p[0], start: time.Now().UTC().Add(time.Hour), rule: r,
			zone: "UTC", invitees: []string{p[1], p[2]}}.tryScheduling(s)
		if !errors.Is(err, ErrForbidden) {
			t.Errorf("repeating=%v: err = %v, want ErrForbidden", r != nil, err)
		}
	}
}

// ── Channels ─────────────────────────────────────────────────────────────────

func TestMeetingRoster_ChannelMembersAreInvitedAndTheChannelIsRecorded(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 5)
	host, m1, m2, outsiderToChannel := p[0], p[1], p[2], p[4]
	ch := newChannel(t, s, org, host, m1, m2)

	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour),
		channels: []string{ch}}.schedule(t, s)

	wantRoster(t, rosterOf(t, s, c.ID), host, m1, m2)
	if _, in := rosterOf(t, s, c.ID)[outsiderToChannel]; in {
		t.Error("someone outside the channel was invited")
	}
	if len(c.ChannelIDs) != 1 || c.ChannelIDs[0] != ch {
		t.Errorf("channelIds = %v, want [%s]", c.ChannelIDs, ch)
	}
	// And it is what a fresh read says, not just what create returned.
	read, err := s.GetCall(context.Background(), org, host, c.ID)
	if err != nil || len(read.ChannelIDs) != 1 || read.ChannelIDs[0] != ch {
		t.Errorf("GetCall channelIds = %v (err %v)", read.ChannelIDs, err)
	}
}

func TestMeetingRoster_SeveralChannelsAndPickedMembersMergeWithoutDuplicates(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 6)
	host, a, b, c2, d := p[0], p[1], p[2], p[3], p[4]
	ch1 := newChannel(t, s, org, host, a, b)
	ch2 := newChannel(t, s, org, host, b, c2)

	// `a` is in ch1 AND picked by name; `b` is in both channels.
	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour),
		invitees: []string{a, d}, channels: []string{ch1, ch2}}.schedule(t, s)

	wantRoster(t, rosterOf(t, s, c.ID), host, a, b, c2, d)
	if len(c.ChannelIDs) != 2 {
		t.Errorf("channelIds = %v", c.ChannelIDs)
	}
}

// You cannot invite a channel's members by naming a channel you are not in — that
// would be a way to read a private channel's membership off the roster.
func TestMeetingRoster_AChannelTheCallerCannotSeeRefusesTheRequest(t *testing.T) {
	s := lifecycleStore(t)
	org, other := newOrg(), newOrg()
	p := seedPeople(t, s, org, 3)
	host, m1, notMine := p[0], p[1], p[2]
	private := newChannel(t, s, org, m1, notMine) // host is NOT a member
	foreignOwner := seedPeople(t, s, other, 1)[0]
	foreign := newChannel(t, s, other, foreignOwner)

	for name, ch := range map[string]string{
		"a channel the caller is not in": private,
		"another org's channel":          foreign,
		"a channel that does not exist":  uuid.NewString(),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour),
				channels: []string{ch}}.tryScheduling(s)
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("err = %v, want ErrForbidden", err)
			}
		})
	}
}

// A channel's members are not chosen one by one, so a member who cannot be
// invited is left out — the request does not fail. Deactivated people, people
// blocked by someone already seated, and people from a channel that has since
// been deleted.
func TestMeetingRoster_ChannelMembersWhoCannotBeInvitedAreSkippedNotFatal(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	p := seedPeople(t, s, org, 5)
	host, ok1, gone, blockedByHost := p[0], p[1], p[2], p[3]
	ch := newChannel(t, s, org, host, ok1, gone, blockedByHost)
	if err := s.SetUserActive(ctx, gone, false); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	if err := s.Block(ctx, org, host, blockedByHost); err != nil {
		t.Fatalf("Block: %v", err)
	}

	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour), channels: []string{ch}}.schedule(t, s)
	wantRoster(t, rosterOf(t, s, c.ID), host, ok1)
}

// Two channel members who block each other cannot share a room, but neither is
// "the" reason the channel cannot be invited: one is seated, the other is not.
func TestMeetingRoster_ABlockedPairInsideAChannelSeatsOneOfThem(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	p := seedPeople(t, s, org, 4)
	host, x, y, z := p[0], p[1], p[2], p[3]
	ch := newChannel(t, s, org, host, x, y, z)
	if err := s.Block(context.Background(), org, x, y); err != nil {
		t.Fatalf("Block: %v", err)
	}
	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour), channels: []string{ch}}.schedule(t, s)
	got := rosterOf(t, s, c.ID)
	if len(got) != 3 { // host + z + exactly one of the blocked pair
		t.Fatalf("roster = %v, want host, z and one of x/y", got)
	}
	_, hasX := got[x]
	_, hasY := got[y]
	if hasX == hasY {
		t.Errorf("x seated=%v, y seated=%v; exactly one of a blocked pair may be seated", hasX, hasY)
	}
	if _, ok := got[z]; !ok {
		t.Error("z, blocked by no one, was left out")
	}
}

// A roster over the cap is refused when a person is waiting to be told.
func TestMeetingRoster_ARosterOverTheCapIsRefused(t *testing.T) {
	s := lifecycleStore(t)
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	ch := seedBigChannel(t, s, org, host, MaxMeetingRoster+5)

	_, err := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour),
		channels: []string{ch}}.tryScheduling(s)
	if !errors.Is(err, ErrMeetingTooLarge) {
		t.Fatalf("err = %v, want ErrMeetingTooLarge", err)
	}
	// Exactly at the cap is fine.
	ok := seedBigChannel(t, s, org, host, MaxMeetingRoster) // the host counts as one member
	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(time.Hour), channels: []string{ok}}.schedule(t, s)
	if n := len(rosterOf(t, s, c.ID)); n != MaxMeetingRoster {
		t.Errorf("roster = %d people", n)
	}
}

// seedBigChannel makes a channel of n members (the organiser among them) with
// plain SQL, since seeding hundreds one call at a time is slow.
func seedBigChannel(t *testing.T, s *Store, org, host string, n int) string {
	t.Helper()
	ch := uuid.NewString()
	bypassExec(t, s, `INSERT INTO channels (id, org_id, name, created_by) VALUES ($1, $2, 'big', $3)`, ch, org, host)
	bypassExec(t, s, `INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1, $2, $3)`, ch, org, host)
	bypassExec(t, s, `
		WITH u AS (
		    SELECT gen_random_uuid() AS id, g FROM generate_series(1, $3::int - 1) g
		), p AS (
		    INSERT INTO user_projection (user_id, org_id, username, display_name)
		    SELECT id, $2, 'big-' || g || '-' || substr(id::text, 1, 6), 'Big ' || g FROM u RETURNING user_id
		)
		INSERT INTO channel_members (channel_id, org_id, user_id, joined_at)
		SELECT $1, $2, user_id, now() FROM p`, ch, org, n)
	return ch
}

// ── Channels keep following the channel ──────────────────────────────────────

// The channel's members are read at each occurrence, never copied onto the
// series: someone who leaves stops being invited to what has not been written
// yet, and someone who joins starts being. Occurrences already written keep what
// they were.
func TestMeetingRoster_TopUpFollowsTheChannelsCurrentMembers(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	p := seedPeople(t, s, org, 4)
	host, stays, leaves, joins := p[0], p[1], p[2], p[3]
	ch := newChannel(t, s, org, host, stays, leaves)
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule,
		zone: "UTC", channels: []string{ch}}.schedule(t, s)
	before := occurrencesOf(t, s, c.Series.ID)
	wantRoster(t, rosterOf(t, s, before[0].id), host, stays, leaves)

	// The channel changes, then the series is topped up from the tenth day on.
	if err := s.LeaveChannel(ctx, org, ch, leaves); err != nil {
		t.Fatalf("LeaveChannel: %v", err)
	}
	bypassExec(t, s, `INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1, $2, $3)`, ch, org, joins)
	cut := before[10]
	bypassExec(t, s, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, c.Series.ID, cut.at)
	bypassExec(t, s, `UPDATE call_series SET occurrence_count = 10, next_start_at = $2 WHERE id = $1`, c.Series.ID, cut.at)
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("TopUpDueSeries: %v", err)
	}

	after := occurrencesOf(t, s, c.Series.ID)
	if len(after) != len(before) {
		t.Fatalf("%d occurrences after top-up, want %d", len(after), len(before))
	}
	wantRoster(t, rosterOf(t, s, after[0].id), host, stays, leaves)           // history is left alone
	wantRoster(t, rosterOf(t, s, after[len(after)-1].id), host, stays, joins) // the new ones follow the channel
}

// channel_members carries no foreign key, so its rows outlive a deleted channel.
// A series addressed to a channel that has since been deleted must stop inviting
// that channel's old members rather than go on expanding a ghost.
func TestMeetingRoster_TopUpIgnoresAChannelThatWasDeleted(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	p := seedPeople(t, s, org, 3)
	host, m1, m2 := p[0], p[1], p[2]
	ch := newChannel(t, s, org, host, m1, m2)
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule,
		zone: "UTC", channels: []string{ch}}.schedule(t, s)
	occ := occurrencesOf(t, s, c.Series.ID)
	wantRoster(t, rosterOf(t, s, occ[0].id), host, m1, m2)

	// Deleted the way the fixture can: the channel row goes, its members stay.
	bypassExec(t, s, `DELETE FROM channels WHERE id = $1`, ch)
	cut := occ[4]
	bypassExec(t, s, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, c.Series.ID, cut.at)
	bypassExec(t, s, `UPDATE call_series SET occurrence_count = 4, next_start_at = $2 WHERE id = $1`, c.Series.ID, cut.at)
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("a deleted channel stalled the series: %v", err)
	}
	after := occurrencesOf(t, s, c.Series.ID)
	wantRoster(t, rosterOf(t, s, after[len(after)-1].id), host)
}

// The background top-up trusts nothing it reads back: even if a series somehow
// named another org's channel, that channel's members are not invited.
func TestMeetingRoster_TopUpNeverExpandsAnotherOrgsChannel(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org, other := newOrg(), newOrg()
	host := seedPeople(t, s, org, 1)[0]
	foreigners := seedPeople(t, s, other, 2)
	foreign := newChannel(t, s, other, foreigners[0], foreigners[1])
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)
	occ := occurrencesOf(t, s, c.Series.ID)

	bypassExec(t, s, `UPDATE call_series SET channel_ids = ARRAY[$2::uuid] WHERE id = $1`, c.Series.ID, foreign)
	cut := occ[4]
	bypassExec(t, s, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, c.Series.ID, cut.at)
	bypassExec(t, s, `UPDATE call_series SET occurrence_count = 4, next_start_at = $2 WHERE id = $1`, c.Series.ID, cut.at)
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("TopUpDueSeries: %v", err)
	}
	after := occurrencesOf(t, s, c.Series.ID)
	wantRoster(t, rosterOf(t, s, after[len(after)-1].id), host) // nobody from the other org
}

// One member deactivated since a series began must not stall the series: the
// later occurrences are written without them and no error surfaces.
func TestMeetingRoster_TopUpDropsAMemberDeactivatedSinceTheSeriesBegan(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	p := seedPeople(t, s, org, 3)
	host, stays, leaves := p[0], p[1], p[2]
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule,
		zone: "UTC", invitees: []string{stays, leaves}}.schedule(t, s)
	occ := occurrencesOf(t, s, c.Series.ID)

	if err := s.SetUserActive(ctx, leaves, false); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	cut := occ[5]
	bypassExec(t, s, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, c.Series.ID, cut.at)
	bypassExec(t, s, `UPDATE call_series SET occurrence_count = 5, next_start_at = $2 WHERE id = $1`, c.Series.ID, cut.at)
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("a deactivated member stalled the series: %v", err)
	}
	after := occurrencesOf(t, s, c.Series.ID)
	wantRoster(t, rosterOf(t, s, after[len(after)-1].id), host, stays)
}

// A channel that has grown past the cap since the series began is truncated in
// the background rather than failing every later occurrence.
func TestMeetingRoster_TopUpTruncatesAChannelThatOutgrewTheCap(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	ch := newChannel(t, s, org, host)
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule,
		zone: "UTC", channels: []string{ch}}.schedule(t, s)
	occ := occurrencesOf(t, s, c.Series.ID)

	bypassExec(t, s, `
		WITH u AS (SELECT gen_random_uuid() AS id, g FROM generate_series(1, 260) g),
		     p AS (INSERT INTO user_projection (user_id, org_id, username, display_name)
		           SELECT id, $2, 'grow-' || g || '-' || substr(id::text, 1, 6), 'G' FROM u RETURNING user_id)
		INSERT INTO channel_members (channel_id, org_id, user_id) SELECT $1, $2, user_id FROM p`, ch, org)
	cut := occ[3]
	bypassExec(t, s, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, c.Series.ID, cut.at)
	bypassExec(t, s, `UPDATE call_series SET occurrence_count = 3, next_start_at = $2 WHERE id = $1`, c.Series.ID, cut.at)
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("an oversized channel stalled the series: %v", err)
	}
	after := occurrencesOf(t, s, c.Series.ID)
	if n := len(rosterOf(t, s, after[len(after)-1].id)); n != MaxMeetingRoster+1 {
		t.Errorf("roster = %d, want the organiser plus exactly %d", n, MaxMeetingRoster)
	}
}

// A guest who joined ONE occurrence by link, from another org, can read that
// occurrence but not the hosting org's series behind it.
func TestMeetingRoster_ACrossOrgGuestSeesTheOccurrenceButNotTheSeries(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org, guestOrg := newOrg(), newOrg()
	host := seedPeople(t, s, org, 1)[0]
	guest := seedPeople(t, s, guestOrg, 1)[0]
	rule := dailyRule()
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)

	inv, err := s.CreateInvite(ctx, org, host, c.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := s.RedeemInvite(ctx, guestOrg, guest, inv.Token); err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}
	got, err := s.GetCall(ctx, guestOrg, guest, c.ID)
	if err != nil {
		t.Fatalf("the guest cannot read the occurrence: %v", err)
	}
	if got.Series != nil {
		t.Errorf("the guest can read the hosting org's series: %+v", got.Series)
	}
	if _, err := s.GetSeries(ctx, guestOrg, guest, c.Series.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("GetSeries as the guest = %v, want ErrForbidden", err)
	}
}
