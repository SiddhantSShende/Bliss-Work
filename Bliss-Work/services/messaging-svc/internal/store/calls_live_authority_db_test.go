package store

// "Live" is decided by the server, from the call's own lifecycle record — never
// by the status column alone.
//
// The bug: a meeting that was over (its scheduled end long gone) was still
// listed under Live Meetings, and opening it answered 403 on the token request.
// The status column said LIVE because only the sweeper moves it, and the
// sweeper had not (or could not) reach the row. These tests pin every read path
// to the lifecycle facts instead: ended_at, ends_at, the status, and — for a
// CHANNEL call — the caller still being in the channel.
//
// Opt-in against a real Postgres, same harness as calls_lifecycle_db_test.go
// (MESSAGING_TEST_DATABASE_URL, a non-superuser role).

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// rawCall is one calls row written directly, so a test can put the table into
// states the service itself would never write (a LIVE call with an ended_at).
type rawCall struct {
	orgID, host string
	kind        string // "" = CHANNEL
	channelID   string
	status      string
	scheduled   *time.Time
	started     *time.Time
	endsAt      *time.Time
	endedAt     *time.Time
	// joinedHost seats the host as connected (joined, not left).
	joinedHost bool
}

func (r rawCall) insert(t *testing.T, s *Store) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.Must(uuid.NewV7()).String()
	kind := r.kind
	if kind == "" {
		kind = CallChannel
	}
	var ch *string
	if r.channelID != "" {
		ch = &r.channelID
	}
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, channel_id, title, created_by,
			                   scheduled_at, started_at, ends_at, ended_at, status, created_at)
			VALUES ($1, $2, $3, $4, 'authority test', $5, $6, $7, $8, $9, $10,
			        LEAST(COALESCE($6, now()), COALESCE($7, now()), now()))`,
			id, r.orgID, kind, ch, r.host, r.scheduled, r.started, r.endsAt, r.endedAt, r.status); err != nil {
			return err
		}
		var joined *time.Time
		if r.joinedHost {
			joined = ago(time.Minute)
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at)
			VALUES ($1, $2, $3, 'HOST', $4)`, id, r.host, r.orgID, joined)
		return err
	}); err != nil {
		t.Fatalf("seed call: %v", err)
	}
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM calls WHERE id = $1`, id)
			return err
		})
	})
	return id
}

func listedStatus(t *testing.T, s *Store, org, user string) map[string]CallDTO {
	t.Helper()
	got, err := s.ListMyCalls(context.Background(), org, user, 100)
	if err != nil {
		t.Fatalf("ListMyCalls: %v", err)
	}
	out := map[string]CallDTO{}
	for _, c := range got {
		out[c.ID] = c
	}
	return out
}

// authorityFixture is an org with one host who is a member of one channel.
func authorityFixture(t *testing.T) (s *Store, org, host, channel string) {
	t.Helper()
	s = lifecycleStore(t)
	org = newOrg()
	host = seedPeople(t, s, org, 1)[0]
	channel = seedActivityChannel(t, s, org, host, host)
	return
}

func TestLiveAuthority_ListMyCallsReportsOnlyGenuinelyOpenCallsAsOpen(t *testing.T) {
	s, org, host, ch := authorityFixture(t)

	active := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		scheduled: ago(30 * time.Minute), started: ago(30 * time.Minute), endsAt: ahead(30 * time.Minute)}.insert(t, s)
	noEnd := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(time.Minute)}.insert(t, s)
	upcoming := rawCall{orgID: org, host: host, channelID: ch, status: "SCHEDULED",
		scheduled: ahead(time.Hour), endsAt: ahead(2 * time.Hour)}.insert(t, s)

	explicit := rawCall{orgID: org, host: host, channelID: ch, status: "ENDED",
		scheduled: ago(3 * time.Hour), started: ago(3 * time.Hour), endsAt: ahead(time.Hour),
		endedAt: ago(2 * time.Hour)}.insert(t, s)
	// Still LIVE in the table; the end time passed an hour ago and no sweeper
	// has touched it. This is the row from the bug report.
	lapsedLive := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		scheduled: ago(3 * time.Hour), started: ago(3 * time.Hour), endsAt: ago(time.Hour)}.insert(t, s)
	// Never started, and its whole window has gone by.
	lapsedScheduled := rawCall{orgID: org, host: host, channelID: ch, status: "SCHEDULED",
		scheduled: ago(3 * time.Hour), endsAt: ago(time.Hour)}.insert(t, s)
	// Inconsistent: the row recorded that it ended, and the status never followed.
	staleInconsistent := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(5 * time.Hour), endedAt: ago(4 * time.Hour)}.insert(t, s)

	got := listedStatus(t, s, org, host)
	for name, want := range map[string]string{
		"active":            "LIVE",
		"noEnd":             "LIVE",
		"upcoming":          "SCHEDULED",
		"explicit":          "ENDED",
		"lapsedLive":        "ENDED",
		"lapsedScheduled":   "ENDED",
		"staleInconsistent": "ENDED",
	} {
		id := map[string]string{
			"active": active, "noEnd": noEnd, "upcoming": upcoming, "explicit": explicit,
			"lapsedLive": lapsedLive, "lapsedScheduled": lapsedScheduled,
			"staleInconsistent": staleInconsistent,
		}[name]
		c, ok := got[id]
		if !ok {
			t.Fatalf("%s: missing from ListMyCalls (a recent finished call belongs in Past)", name)
		}
		if c.Status != want {
			t.Errorf("%s: status = %s, want %s", name, c.Status, want)
		}
		if want == "ENDED" && c.EndedAt == nil {
			t.Errorf("%s: reported ENDED with no endedAt", name)
		}
	}
	// The lapsed call is ended AS OF its scheduled end, not as of "now".
	if end := got[lapsedLive].EndedAt; end == nil || *end != *got[lapsedLive].EndsAt {
		t.Errorf("lapsed call endedAt = %v, want its endsAt %v", end, got[lapsedLive].EndsAt)
	}
}

func TestLiveAuthority_OldFinishedCallsStayOutOfTheWindow(t *testing.T) {
	s, org, host, ch := authorityFixture(t)
	old := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		scheduled: ago(90 * 24 * time.Hour), started: ago(90 * 24 * time.Hour),
		endsAt: ago(90*24*time.Hour - time.Hour)}.insert(t, s)
	if _, ok := listedStatus(t, s, org, host)[old]; ok {
		t.Fatal("a call that lapsed 90 days ago and was never swept is listed; it must age out like any ended call")
	}
}

func TestLiveAuthority_RecurringSeriesOnlyLosesThePastOccurrence(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	first := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(2 * time.Hour), rule: &rule, zone: "UTC"}.schedule(t, s)

	before := listedStatus(t, s, org, host)
	var future []string
	for id, c := range before {
		if c.Series != nil && c.Series.ID == first.Series.ID && id != first.ID {
			future = append(future, id)
		}
	}
	if len(future) == 0 {
		t.Fatal("fixture: the series wrote no later occurrences")
	}

	// Wind THIS occurrence back to a LIVE call whose window has passed.
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE calls SET status = 'LIVE', scheduled_at = now() - interval '3 hours',
			       started_at = now() - interval '3 hours', ends_at = now() - interval '2 hours'
			WHERE id = $1`, first.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	after := listedStatus(t, s, org, host)
	if got := after[first.ID].Status; got != "ENDED" {
		t.Errorf("the past occurrence is %q, want ENDED", got)
	}
	for _, id := range future {
		if got := after[id].Status; got != "SCHEDULED" {
			t.Errorf("future occurrence %s is %q, want SCHEDULED — only the past one may go", id, got)
		}
	}
}

func TestLiveAuthority_ChannelCallIsOnlyListedOpenToCurrentMembers(t *testing.T) {
	s, org, host, ch := authorityFixture(t)
	ctx := context.Background()
	id := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(time.Minute), endsAt: ahead(time.Hour)}.insert(t, s)

	if listedStatus(t, s, org, host)[id].Status != "LIVE" {
		t.Fatal("a current channel member does not see the live channel call")
	}

	// The host leaves the channel but keeps their participant row.
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, ch, host)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if c, ok := listedStatus(t, s, org, host)[id]; ok && (c.Status == "LIVE" || c.Status == "SCHEDULED") {
		t.Fatalf("a call the caller can no longer enter is still listed as %s", c.Status)
	}
	// And the gate behind it is unchanged: still a refusal, never a token.
	if _, err := s.AuthorizeCallAccess(ctx, org, host, id, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-member token access = %v, want ErrForbidden (authorization must not be weakened)", err)
	}
}

func TestLiveAuthority_TokenGateRefusesALapsedOrEndedCallButAdmitsAnActiveOne(t *testing.T) {
	s, org, host, ch := authorityFixture(t)
	ctx := context.Background()

	active := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(time.Minute), endsAt: ahead(time.Hour)}.insert(t, s)
	lapsed := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(3 * time.Hour), endsAt: ago(time.Hour)}.insert(t, s)
	ended := rawCall{orgID: org, host: host, channelID: ch, status: "ENDED",
		started: ago(3 * time.Hour), endedAt: ago(2 * time.Hour)}.insert(t, s)
	inconsistent := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(3 * time.Hour), endedAt: ago(2 * time.Hour)}.insert(t, s)

	if acc, err := s.AuthorizeCallAccess(ctx, org, host, active, nil); err != nil || acc.Waiting {
		t.Fatalf("active call: access=%+v err=%v, want admitted", acc, err)
	}
	for name, id := range map[string]string{"lapsed": lapsed, "ended": ended, "inconsistent": inconsistent} {
		if _, err := s.AuthorizeCallAccess(ctx, org, host, id, nil); !errors.Is(err, ErrCallEnded) {
			t.Errorf("%s call: err = %v, want ErrCallEnded (a 409 the client can explain), not a token and not a 403", name, err)
		}
	}
	// The other doors guard the same fact.
	if _, _, err := s.StartCall(ctx, org, host, lapsed, nil); !errors.Is(err, ErrCallEnded) {
		t.Errorf("StartCall on a lapsed call = %v, want ErrCallEnded", err)
	}
}

func TestLiveAuthority_GetCallAndChannelListAgree(t *testing.T) {
	s, org, host, ch := authorityFixture(t)
	ctx := context.Background()
	lapsed := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(3 * time.Hour), endsAt: ago(time.Hour)}.insert(t, s)
	active := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(time.Minute), endsAt: ahead(time.Hour)}.insert(t, s)

	c, err := s.GetCall(ctx, org, host, lapsed)
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != "ENDED" || c.EndedAt == nil {
		t.Errorf("GetCall(lapsed) = %s endedAt=%v, want ENDED with an endedAt", c.Status, c.EndedAt)
	}
	open, err := s.ListChannelCalls(ctx, org, host, ch, 50)
	if err != nil {
		t.Fatal(err)
	}
	ids := callIDsOf(open)
	if len(ids) != 1 || ids[0] != active {
		t.Errorf("ListChannelCalls = %v, want only the active call %s", ids, active)
	}
}

func TestLiveAuthority_SweepClosesTheRowsReadsAlreadyTreatAsOver(t *testing.T) {
	s, org, host, ch := authorityFixture(t)
	ctx := context.Background()

	lapsed := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(3 * time.Hour), endsAt: ago(time.Hour)}.insert(t, s)
	// No end time and nobody ever came: only the abandoned rule can close this.
	abandoned := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		scheduled: ago(14 * time.Hour), started: ago(14 * time.Hour)}.insert(t, s)
	recent := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		scheduled: ago(time.Hour), started: ago(time.Hour)}.insert(t, s)
	occupied := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(14 * time.Hour), joinedHost: true}.insert(t, s)
	inconsistent := rawCall{orgID: org, host: host, channelID: ch, status: "LIVE",
		started: ago(time.Hour), endedAt: ago(30 * time.Minute)}.insert(t, s)

	if _, err := s.ExpireOverdueCalls(ctx, 500); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExpireAbandonedCalls(ctx, AbandonedCallAfter, 500); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]struct{ id, status string }{
		"lapsed":       {lapsed, "ENDED"},
		"abandoned":    {abandoned, "ENDED"},
		"inconsistent": {inconsistent, "ENDED"},
		// Must NOT be touched: a call someone is in, and one that is merely quiet.
		"recent":   {recent, "LIVE"},
		"occupied": {occupied, "LIVE"},
	} {
		if got := callStatus(t, s, want.id); got != want.status {
			t.Errorf("%s: stored status = %s, want %s", name, got, want.status)
		}
	}
	// The recorded end is kept, not restamped to the sweep.
	var kept time.Time
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT ended_at FROM calls WHERE id = $1`, inconsistent).Scan(&kept)
	}); err != nil {
		t.Fatal(err)
	}
	if time.Since(kept) < 25*time.Minute {
		t.Errorf("ended_at was restamped to %v; the recorded end must survive", kept)
	}
}
