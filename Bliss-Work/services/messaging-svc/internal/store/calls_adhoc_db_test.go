package store

// Ad-hoc calls (DIRECT, no scheduled_at) that grow from a 1:1 into a conference,
// against a real Postgres with RLS enforcing. See calls_lifecycle_db_test.go's
// header for the harness (opt-in via MESSAGING_TEST_DATABASE_URL).
//
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run 'TestAdhoc|TestConference' -v

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func seedMany(t *testing.T, s *Store, orgID string, n int) []string {
	t.Helper()
	ids := make([]string, n)
	for i := range ids {
		ids[i] = uuid.Must(uuid.NewV7()).String()
		seedUser(t, s, orgID, ids[i], fmt.Sprintf("adhoc-%d", i), fmt.Sprintf("Adhoc %d", i))
	}
	return ids
}

func callsInOrg(t *testing.T, s *Store, orgID string) int {
	t.Helper()
	ctx := context.Background()
	var n int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM calls WHERE org_id = $1`, orgID).Scan(&n)
	}); err != nil {
		t.Fatalf("count calls: %v", err)
	}
	return n
}

// join seats a participant as connected, the way the token endpoint does.
func join(t *testing.T, s *Store, orgID, callID string, users ...string) {
	t.Helper()
	for _, u := range users {
		if err := s.MarkJoined(context.Background(), orgID, u, callID); err != nil {
			t.Fatalf("MarkJoined(%s): %v", u, err)
		}
	}
}

// backdateDeparture pushes every CURRENT departure (left_at IS NOT NULL) on
// callID far enough into the past that ExpireEmptyConferences' grace period
// has elapsed — the same time-travel trick TestAdhocConferenceIsNotHostlessWhileOthersAreIn
// already uses for ExpireHostlessCalls, applied to every participant row at
// once rather than one.
func backdateDeparture(t *testing.T, s *Store, callID string, ago time.Duration) {
	t.Helper()
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			UPDATE call_participants SET left_at = left_at - $2::interval
			WHERE call_id = $1 AND left_at IS NOT NULL`, callID, ago)
		return err
	}); err != nil {
		t.Fatalf("backdate: %v", err)
	}
}

// participantRow is one call_participants row read directly, for asserting on
// columns the DTO does not expose (joined_at/left_at themselves, not just
// whether they're set).
type participantRow struct {
	joinedAt, leftAt *time.Time
}

func getParticipantRow(t *testing.T, s *Store, callID, userID string) participantRow {
	t.Helper()
	var r participantRow
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT joined_at, left_at FROM call_participants
			WHERE call_id = $1 AND user_id = $2`, callID, userID).Scan(&r.joinedAt, &r.leftAt)
	}); err != nil {
		t.Fatalf("read participant row: %v", err)
	}
	return r
}

func listedIDs(calls []CallDTO) map[string]bool {
	out := map[string]bool{}
	for _, c := range calls {
		out[c.ID] = true
	}
	return out
}

// ── 1:1 → conference, and it stays the same ad-hoc call ──────────────────────

func TestAdhocCallGrowsIntoAConferenceWithoutBecomingAMeeting(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 5)
	a, b, c, d, e := u[0], u[1], u[2], u[3], u[4]

	call, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("1:1: %v", err)
	}
	if err := s.AddParticipant(ctx, org, a, call.ID, c); err != nil {
		t.Fatalf("1:1 -> 3: %v", err)
	}
	for _, x := range []string{d, e} { // 3 -> 4 -> 5, by different people
		if err := s.AddParticipant(ctx, org, b, call.ID, x); err != nil {
			t.Fatalf("add %s: %v", x, err)
		}
	}

	got, err := s.GetCall(ctx, org, a, call.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ID != call.ID || got.Kind != CallDirect || got.ScheduledAt != nil || got.Status != CallLive {
		t.Fatalf("call changed shape: id=%s kind=%s scheduled=%v status=%s", got.ID, got.Kind, got.ScheduledAt, got.Status)
	}
	if len(got.Participants) != 5 {
		t.Fatalf("participants = %d, want 5", len(got.Participants))
	}
	if !IsAdhocDirect(got) {
		t.Fatal("a widened 1:1 must still be an ad-hoc call")
	}
	if n := callsInOrg(t, s, org); n != 1 {
		t.Fatalf("calls in org = %d, want exactly the one", n)
	}
	// No Meeting machinery: there is no invite link to mint for it.
	if _, err := s.CreateInvite(ctx, org, a, call.ID, time.Hour, nil); !errors.Is(err, ErrNoInviteForKind) {
		t.Fatalf("CreateInvite on a conference = %v, want ErrNoInviteForKind", err)
	}
}

func TestAdhocCallParticipantLimit(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, MaxAdhocCallParticipants+2)

	call, err := s.CreateDirectCall(ctx, org, u[0], u[1], "", "video", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 2; i < MaxAdhocCallParticipants; i++ {
		if err := s.AddParticipant(ctx, org, u[0], call.ID, u[i]); err != nil {
			t.Fatalf("add #%d: %v", i, err)
		}
	}
	if err := s.AddParticipant(ctx, org, u[0], call.ID, u[MaxAdhocCallParticipants]); !errors.Is(err, ErrCallFull) {
		t.Fatalf("add past the limit = %v, want ErrCallFull", err)
	}
	// Re-adding someone already seated is not a new seat.
	if err := s.AddParticipant(ctx, org, u[0], call.ID, u[2]); err != nil {
		t.Fatalf("re-add of a seated participant: %v", err)
	}
	// Someone leaving frees their seat.
	if _, _, _, err := s.LeaveCall(ctx, org, u[3], call.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.AddParticipant(ctx, org, u[0], call.ID, u[MaxAdhocCallParticipants]); err != nil {
		t.Fatalf("add after a seat freed: %v", err)
	}
}

// ── Not a Meeting: absent from every Meetings read ───────────────────────────

func TestAdhocCallIsNotInMeetings(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 4)
	a, b, c, d := u[0], u[1], u[2], u[3]

	oneToOne, err := s.CreateDirectCall(ctx, org, a, b, "", "video", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	conf, err := s.CreateConferenceCall(ctx, org, a, []string{c, d}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	scheduledAt := time.Now().UTC().Add(2 * time.Hour)
	scheduledDirect, err := s.CreateDirectCall(ctx, org, a, b, "Sync", "video", &scheduledAt, nil)
	if err != nil {
		t.Fatal(err)
	}
	meeting, err := s.ScheduleMeeting(ctx, org, a, "Standup", "video", &scheduledAt, nil, []string{b})
	if err != nil {
		t.Fatal(err)
	}

	assertLists := func(stage string) {
		t.Helper()
		mine, err := s.ListMyCalls(ctx, org, a, 100)
		if err != nil {
			t.Fatal(err)
		}
		got := listedIDs(mine)
		if got[oneToOne.ID] || got[conf.ID] {
			t.Fatalf("%s: an ad-hoc call is listed in Meetings", stage)
		}
		if !got[scheduledDirect.ID] || !got[meeting.ID] {
			t.Fatalf("%s: a scheduled call or a meeting went missing: %v", stage, got)
		}
		inRange, err := s.ListMyCallsInRange(ctx, org, a, time.Now().Add(-48*time.Hour), time.Now().Add(48*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if r := listedIDs(inRange); r[oneToOne.ID] || r[conf.ID] || !r[meeting.ID] {
			t.Fatalf("%s: calendar range wrong: %v", stage, r)
		}
	}
	assertLists("live")

	// Once over they must not become Meetings history either.
	for _, id := range []string{oneToOne.ID, conf.ID} {
		if _, err := s.EndCall(ctx, org, a, id); err != nil {
			t.Fatalf("end: %v", err)
		}
	}
	assertLists("ended")
	page, err := s.ListMyCallHistory(ctx, org, a, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if h := listedIDs(page.Items); h[oneToOne.ID] || h[conf.ID] {
		t.Fatalf("an ended ad-hoc call is in Meetings history: %v", h)
	}
}

// ── Leaving ──────────────────────────────────────────────────────────────────

func TestAdhocConferenceContinuesWhenTheHostLeaves(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	host, b, c := u[0], u[1], u[2]

	call, err := s.CreateConferenceCall(ctx, org, host, []string{b, c}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	join(t, s, org, call.ID, host, b, c)

	_, _, ended, err := s.LeaveCall(ctx, org, host, call.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ended != nil {
		t.Fatal("the host leaving ended a conference that still had two people in it")
	}
	if got, _ := s.GetCall(ctx, org, b, call.ID); got.Status != CallLive {
		t.Fatalf("status after host left = %s, want LIVE", got.Status)
	}

	// Not the last one yet.
	if _, _, ended, err = s.LeaveCall(ctx, org, b, call.ID); err != nil || ended != nil {
		t.Fatalf("second leave: ended=%v err=%v, want the call to go on", ended, err)
	}
	// The LAST participant leaving does not end it SYNCHRONOUSLY either — that
	// is exactly the race this file exists to not have (see adhocEndsOnLeave).
	// It stays LIVE immediately afterward...
	_, _, ended, err = s.LeaveCall(ctx, org, c, call.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ended != nil {
		t.Fatal("LeaveCall ended a conference synchronously — that decision belongs to the sweeper")
	}
	if got, _ := s.GetCall(ctx, org, host, call.ID); got.Status != CallLive {
		t.Fatalf("status immediately after the last departure = %s, want still LIVE", got.Status)
	}
	// ...until ExpireEmptyConferences, given enough time, closes it for real.
	backdateDeparture(t, s, call.ID, ConferenceEmptyGracePeriod+time.Second)
	endedCalls, err := s.ExpireEmptyConferences(ctx, ConferenceEmptyGracePeriod, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(endedCalls) != 1 || endedCalls[0].ID != call.ID || endedCalls[0].Status != CallEnded {
		t.Fatalf("ExpireEmptyConferences = %+v, want exactly this call ended", endedCalls)
	}
}

// The exact race this fix exists for: a conference where the host's departure
// is the LAST thing to make `present` read zero, and a DIFFERENT participant's
// own join lands moments later — before the grace period has elapsed. The
// conference must still be standing (and un-ended) once that join lands, and
// the sweeper must leave it alone even once the grace period is long past,
// because it is no longer empty.
func TestAdhocConferenceSurvivesALateJoinerRacingTheHostsDeparture(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	host, b, c := u[0], u[1], u[2]

	call, err := s.CreateConferenceCall(ctx, org, host, []string{b, c}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	// Only the host has actually reached the room so far; b and c are still
	// mid-handoff (rung, not yet connected) — the ordinary shape of a conference
	// the instant after it widens.
	join(t, s, org, call.ID, host)

	// The host's own departure is what brings `present` to zero.
	if _, _, ended, err := s.LeaveCall(ctx, org, host, call.ID); err != nil || ended != nil {
		t.Fatalf("host leaves: ended=%v err=%v, want the call to stand", ended, err)
	}

	// b's own callToken request — already on the wire before the host hung up —
	// lands a moment later: this is MarkJoined, not a new request the departure
	// could have raced out of existence.
	join(t, s, org, call.ID, b)

	// Even once the grace period is well past, the sweeper must not touch a
	// conference that has someone in it.
	backdateDeparture(t, s, call.ID, ConferenceEmptyGracePeriod+time.Second)
	endedCalls, err := s.ExpireEmptyConferences(ctx, ConferenceEmptyGracePeriod, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range endedCalls {
		if e.ID == call.ID {
			t.Fatal("the sweeper ended a conference a late joiner had already rejoined")
		}
	}
	if got, _ := s.GetCall(ctx, org, c, call.ID); got.Status != CallLive {
		t.Fatalf("status = %s, want LIVE", got.Status)
	}
}

func TestAdhocOneToOneStillEndsWhenTheHostLeaves(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 2)

	call, err := s.CreateDirectCall(ctx, org, u[0], u[1], "", "video", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Even the callee never answering: the caller hanging up closes the row.
	_, _, ended, err := s.LeaveCall(ctx, org, u[0], call.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ended == nil {
		t.Fatal("a 1:1 must still end when its host leaves")
	}
}

func TestAdhocConferenceDecliningDoesNotEndIt(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 4)
	host, b, c, d := u[0], u[1], u[2], u[3]

	call, err := s.CreateConferenceCall(ctx, org, host, []string{b, c, d}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	// Host is still on the pre-join screen (not joined); everyone declines.
	for _, x := range []string{b, c, d} {
		if _, _, ended, err := s.LeaveCall(ctx, org, x, call.ID); err != nil || ended != nil {
			t.Fatalf("%s declined: ended=%v err=%v — a decline must not end the call", x, ended, err)
		}
	}
	// A bystander in the org who is not on the call cannot end it either.
	outsider := seedMany(t, s, org, 1)[0]
	if _, _, ended, err := s.LeaveCall(ctx, org, outsider, call.ID); err == nil && ended != nil {
		t.Fatal("someone not on the call ended it by leaving")
	}
	// The host backing out of the pre-join screen does not end it either —
	// NOTHING ends a conference synchronously from a leave any more (see
	// adhocEndsOnLeave). Nobody here has ever actually joined, so this is not
	// ExpireEmptyConferences' case either (it requires a real join to anchor
	// its grace period to) — it is left entirely to the much longer
	// ExpireAbandonedCalls fallback, exactly like any other call nobody answers.
	_, _, ended, err := s.LeaveCall(ctx, org, host, call.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ended != nil {
		t.Fatal("the host leaving a never-joined conference ended it synchronously")
	}
	backdateDeparture(t, s, call.ID, ConferenceEmptyGracePeriod+time.Second)
	endedCalls, err := s.ExpireEmptyConferences(ctx, ConferenceEmptyGracePeriod, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range endedCalls {
		if e.ID == call.ID {
			t.Fatal("ExpireEmptyConferences ended a conference nobody ever joined — that is ExpireAbandonedCalls' job")
		}
	}
}

func TestAdhocConferenceIsNotHostlessWhileOthersAreIn(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	host, b, c := u[0], u[1], u[2]

	withOthers, err := s.CreateConferenceCall(ctx, org, host, []string{b, c}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	join(t, s, org, withOthers.ID, host, b)
	if err := s.withBypass(ctx, func(tx pgx.Tx) error { // the host drops without saying so
		_, err := tx.Exec(ctx, `UPDATE call_participants SET left_at = now() - interval '1 minute'
			WHERE call_id = $1 AND user_id = $2`, withOthers.ID, host)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	empty, err := s.CreateConferenceCall(ctx, org, host, []string{b, c}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	join(t, s, org, empty.ID, host)
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE call_participants SET left_at = now() - interval '1 minute'
			WHERE call_id = $1 AND user_id = $2`, empty.ID, host)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	endedCalls, err := s.ExpireHostlessCalls(ctx, time.Second, 100)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, e := range endedCalls {
		ids[e.ID] = true
	}
	if ids[withOthers.ID] {
		t.Fatal("the sweeper ended a conference that still has someone in it")
	}
	if !ids[empty.ID] {
		t.Fatal("the sweeper should still end a conference with nobody left in it")
	}
}

// ── The multi-select "Call" ──────────────────────────────────────────────────

func TestConferenceCallCreatesOneCallRingingEveryone(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 4)

	call, err := s.CreateConferenceCall(ctx, org, u[0], u[1:], "", "audio")
	if err != nil {
		t.Fatal(err)
	}
	if n := callsInOrg(t, s, org); n != 1 {
		t.Fatalf("calls = %d, want exactly one", n)
	}
	if call.Kind != CallDirect || call.ScheduledAt != nil || call.Status != CallLive || call.Media != "audio" {
		t.Fatalf("unexpected call: %+v", call)
	}
	roles := map[string]string{}
	for _, p := range call.Participants {
		roles[p.UserID] = p.Role
	}
	if len(roles) != 4 || roles[u[0]] != RoleHost || roles[u[1]] != RoleParticipant ||
		roles[u[2]] != RoleParticipant || roles[u[3]] != RoleParticipant {
		t.Fatalf("roster = %v", roles)
	}
}

func TestConferenceCallAuthorization(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 4)
	foreign := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, uuid.Must(uuid.NewV7()).String(), foreign, "foreign", "Foreign")

	if _, err := s.CreateConferenceCall(ctx, org, u[0], []string{u[1], foreign}, "", "video"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a peer from another org = %v, want ErrForbidden", err)
	}
	if _, err := s.CreateConferenceCall(ctx, org, u[0], []string{u[1], u[0]}, "", "video"); !errors.Is(err, ErrSelfCall) {
		t.Fatalf("calling yourself = %v, want ErrSelfCall", err)
	}
	if _, err := s.CreateConferenceCall(ctx, org, u[0], []string{u[1], u[1]}, "", "video"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a duplicate peer = %v, want ErrForbidden", err)
	}
	if err := s.Block(ctx, org, u[1], u[0]); err != nil { // peer blocked the caller
		t.Fatal(err)
	}
	if _, err := s.CreateConferenceCall(ctx, org, u[0], []string{u[1], u[2]}, "", "video"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a peer who blocked the caller = %v, want ErrForbidden", err)
	}
	if err := s.Unblock(ctx, org, u[1], u[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.Block(ctx, org, u[2], u[3]); err != nil { // two peers who block each other
		t.Fatal(err)
	}
	if _, err := s.CreateConferenceCall(ctx, org, u[0], []string{u[2], u[3]}, "", "video"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("two peers with a block between them = %v, want ErrForbidden", err)
	}
	if n := callsInOrg(t, s, org); n != 0 {
		t.Fatalf("a refused conference left %d call row(s) behind", n)
	}

	many := seedMany(t, s, org, MaxAdhocCallParticipants+1)
	if _, err := s.CreateConferenceCall(ctx, org, u[0], many, "", "video"); !errors.Is(err, ErrCallFull) {
		t.Fatalf("over the participant limit = %v, want ErrCallFull", err)
	}
	if _, err := s.CreateConferenceCall(ctx, org, u[0], many[:MaxAdhocCallParticipants-1], "", "video"); err != nil {
		t.Fatalf("exactly the limit: %v", err)
	}
}

// ── The rule itself ──────────────────────────────────────────────────────────

func TestAdhocShouldEnd(t *testing.T) {
	live := &callRow{orgID: "o", kind: CallDirect, status: CallLive, adhoc: true}
	host := callerSeat{role: RoleHost}
	guest := callerSeat{role: RoleParticipant}
	cases := []struct {
		name     string
		seat     callerSeat
		roster   int
		wantEnds bool
	}{
		{"1:1, host leaves", host, 2, true},
		{"1:1, guest leaves", guest, 2, false},
		// A conference NEVER ends synchronously from a leave, whoever it is and
		// however many (or few) seats are left — see adhocEndsOnLeave's own doc
		// comment for why: that question is ExpireEmptyConferences', not this
		// function's, so there is no "present"/"leaverWasIn" input left to vary.
		{"conference, host leaves, others presumably in", host, 3, false},
		{"conference, host leaves, presumably last", host, 3, false},
		{"conference, guest leaves, presumably last", guest, 3, false},
		{"conference, not on the roster", callerSeat{}, 3, false},
	}
	for _, tc := range cases {
		if got := adhocShouldEnd("o", tc.seat, live, tc.roster); got != tc.wantEnds {
			t.Errorf("%s: ends = %v, want %v", tc.name, got, tc.wantEnds)
		}
	}
}

// ── The stale-joined-state bug: a removed-then-re-added participant must not
//    be counted "present" before they have actually rejoined ──────────────────

func TestReAddingAParticipantWhoLeftDoesNotStayCountedPresent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := uuid.Must(uuid.NewV7()).String()
	u := seedMany(t, s, org, 3)
	host, b, c := u[0], u[1], u[2]

	call, err := s.CreateConferenceCall(ctx, org, host, []string{b, c}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	join(t, s, org, call.ID, host, b, c)

	// b genuinely leaves.
	if _, _, ended, err := s.LeaveCall(ctx, org, b, call.ID); err != nil || ended != nil {
		t.Fatalf("b leaves: ended=%v err=%v", ended, err)
	}
	if row := getParticipantRow(t, s, call.ID, b); row.joinedAt == nil || row.leftAt == nil {
		t.Fatalf("after leaving, b's row = %+v, want both joined_at and left_at set", row)
	}

	// Re-added — rung again, not reconnected. The stale joined_at from the
	// earlier stint must be cleared along with left_at, or b would read as
	// "present" from the instant of re-invitation rather than from an actual
	// rejoin.
	if err := s.AddParticipant(ctx, org, host, call.ID, b); err != nil {
		t.Fatal(err)
	}
	row := getParticipantRow(t, s, call.ID, b)
	if row.leftAt != nil {
		t.Fatalf("re-added participant still shows left_at = %v", row.leftAt)
	}
	if row.joinedAt != nil {
		t.Fatalf("re-added participant's STALE joined_at survived the re-add: %v — "+
			"they would be counted present before they have actually rejoined", row.joinedAt)
	}

	// Concretely: with host and c both gone, a stale-present b would stop
	// ExpireEmptyConferences from EVER closing the conference, even though
	// nobody has actually been in the room since b was re-invited.
	if _, _, ended, err := s.LeaveCall(ctx, org, host, call.ID); err != nil || ended != nil {
		t.Fatalf("host leaves: ended=%v err=%v", ended, err)
	}
	if _, _, ended, err := s.LeaveCall(ctx, org, c, call.ID); err != nil || ended != nil {
		t.Fatalf("c leaves: ended=%v err=%v", ended, err)
	}
	backdateDeparture(t, s, call.ID, ConferenceEmptyGracePeriod+time.Second)
	endedCalls, err := s.ExpireEmptyConferences(ctx, ConferenceEmptyGracePeriod, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(endedCalls) != 1 || endedCalls[0].ID != call.ID {
		t.Fatalf("ExpireEmptyConferences = %+v, want this call ended — a stale joined_at must not block it", endedCalls)
	}

	// Re-adding someone who is STILL actively in the call (never left) must
	// leave their real joined_at alone.
	call2, err := s.CreateConferenceCall(ctx, org, host, []string{b, c}, "", "video")
	if err != nil {
		t.Fatal(err)
	}
	join(t, s, org, call2.ID, host, b, c)
	before := getParticipantRow(t, s, call2.ID, b)
	if err := s.AddParticipant(ctx, org, host, call2.ID, b); err != nil {
		t.Fatal(err)
	}
	after := getParticipantRow(t, s, call2.ID, b)
	if after.joinedAt == nil || !after.joinedAt.Equal(*before.joinedAt) {
		t.Fatalf("re-adding a still-present participant changed joined_at: %v -> %v", before.joinedAt, after.joinedAt)
	}
	if after.leftAt != nil {
		t.Fatalf("re-adding a still-present participant set left_at: %v", after.leftAt)
	}
}
