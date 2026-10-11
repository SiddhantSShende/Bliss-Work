package api

// Ad-hoc calls growing into conferences, through the real router.
//
// See meeting_series_http_db_test.go for how to run this
// (MESSAGING_API_TEST_DATABASE_URL, a non-superuser role).
//
// What this locks in: adding a person to a 1:1 call rings them (a call.ring with
// the adder's name, not a Meeting invitation), keeps the one call, never makes a
// Meeting; a multi-select Call is ONE call that rings everyone; and the call
// refuses what it should.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/store"
)

// ringEvents are this org's call.ring payloads, oldest first.
func (f *httpFixture) ringEvents() []map[string]any {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, _ = tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
	rows, err := tx.Query(ctx, `SELECT payload FROM outbox
		WHERE payload->>'type' = 'call.ring' AND payload->>'orgId' = $1 ORDER BY created_at, id`, f.org)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			f.t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		out = append(out, m)
	}
	return out
}

func (f *httpFixture) org4() (host, b, c, d string) { return f.host, f.ada, f.grace, f.rival }

func TestAddingToAnAdhocCallRingsWithoutMakingAMeeting(t *testing.T) {
	f := newHTTPFixture(t)
	host, b, c, d := f.org4()
	as := f.as(host, f.org)

	code, body := as("POST", "/api/v1/calls/direct", map[string]any{"peerId": b})
	if code != 201 {
		t.Fatalf("1:1 = %d %s", code, body)
	}
	call := decode[callResp](t, body)

	for _, who := range []string{c, d} { // 1:1 -> 3 -> 4
		if code, body := as("POST", "/api/v1/calls/"+call.ID+"/participants", map[string]any{"userId": who}); code != 200 {
			t.Fatalf("add %s = %d %s", who, code, body)
		}
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE org_id = $1`, f.org); n != 1 {
		t.Fatalf("calls = %d, want the one call", n)
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE org_id = $1 AND kind = 'MEETING'`, f.org); n != 0 {
		t.Fatalf("a Meeting was created while growing a call")
	}
	if n := f.count(`SELECT count(*) FROM call_participants WHERE call_id = $1`, call.ID); n != 4 {
		t.Fatalf("roster = %d, want 4", n)
	}

	rings := f.ringEvents()
	if len(rings) != 2 {
		t.Fatalf("call.ring events = %d, want 2 (one per person added)", len(rings))
	}
	for i, r := range rings {
		if r["kind"] != "DIRECT" || r["scheduledAt"] != nil && r["scheduledAt"] != "" {
			t.Errorf("ring %d is not an ad-hoc call: kind=%v scheduledAt=%v", i, r["kind"], r["scheduledAt"])
		}
		if r["actorName"] == nil || r["actorName"] == "" {
			t.Errorf("ring %d carries no actorName — the notification cannot say who added you", i)
		}
		members, _ := r["members"].([]any)
		want := []string{c, d}[i]
		if len(members) != 1 || members[0] != want {
			t.Errorf("ring %d members = %v, want only %s", i, members, want)
		}
	}
	// Meeting machinery stays out of it: no link, and not in the Meetings list.
	if code, _ := as("POST", "/api/v1/calls/"+call.ID+"/invites", map[string]any{}); code != 400 {
		t.Errorf("minting an invite link for an ad-hoc call = %d, want 400", code)
	}
	if _, listed := listedCalls(t, f, host)[call.ID]; listed {
		t.Error("an ad-hoc call is in the Meetings list")
	}
	// ...but it is still readable, which is how its room opens.
	if code, _ := as("GET", "/api/v1/calls/"+call.ID, nil); code != 200 {
		t.Errorf("GET ad-hoc call = %d, want 200", code)
	}
}

func TestMultiSelectCallIsOneCallThatRingsEveryone(t *testing.T) {
	f := newHTTPFixture(t)
	host, b, c, d := f.org4()
	as := f.as(host, f.org)

	code, body := as("POST", "/api/v1/calls/direct", map[string]any{"peerIds": []string{b, c, d}, "media": "audio"})
	if code != 201 {
		t.Fatalf("conference = %d %s", code, body)
	}
	call := decode[map[string]any](t, body)
	if call["kind"] != "DIRECT" || call["status"] != "LIVE" || call["scheduledAt"] != nil {
		t.Fatalf("unexpected call: %v", call)
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE org_id = $1`, f.org); n != 1 {
		t.Fatalf("calls = %d, want exactly one", n)
	}
	rings := f.ringEvents()
	if len(rings) != 1 {
		t.Fatalf("call.ring events = %d, want 1", len(rings))
	}
	members, _ := rings[0]["members"].([]any)
	got := map[any]bool{}
	for _, m := range members {
		got[m] = true
	}
	if len(got) != 3 || !got[b] || !got[c] || !got[d] || got[host] {
		t.Fatalf("rung %v, want exactly b, c and d", members)
	}
}

func TestMultiSelectCallValidationAndAuthorization(t *testing.T) {
	f := newHTTPFixture(t)
	host, b, c, _ := f.org4()
	as := f.as(host, f.org)

	for name, req := range map[string]map[string]any{
		"a single entry":         {"peerIds": []string{b}},
		"a scheduled conference": {"peerIds": []string{b, c}, "scheduledAt": "2999-01-01T10:00:00Z"},
		"a titled conference":    {"peerIds": []string{b, c}, "title": "Standup"},
		"peerId and peerIds":     {"peerId": b, "peerIds": []string{b, c}},
		"a malformed id":         {"peerIds": []string{b, "nope"}},
		"a duplicate":            {"peerIds": []string{b, b}},
		"yourself":               {"peerIds": []string{b, host}},
		"an unknown media":       {"peerIds": []string{b, c}, "media": "hologram"},
	} {
		if code, body := as("POST", "/api/v1/calls/direct", req); code != 400 {
			t.Errorf("%s = %d %s, want 400", name, code, body)
		}
	}
	if code, _ := as("POST", "/api/v1/calls/direct", map[string]any{"peerIds": []string{b, f.stranger}}); code != 403 {
		t.Errorf("a person from another org = %d, want 403", code)
	}
	tooMany := make([]string, 0, 25)
	for i := 0; i < 25; i++ {
		tooMany = append(tooMany, uuid.NewString())
	}
	if code, _ := as("POST", "/api/v1/calls/direct", map[string]any{"peerIds": tooMany}); code != 409 {
		t.Errorf("over the participant limit = %d, want 409", code)
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE org_id = $1`, f.org); n != 0 {
		t.Errorf("refused requests left %d call(s) behind", n)
	}
	if n := len(f.ringEvents()); n != 0 {
		t.Errorf("refused requests rang %d time(s)", n)
	}
	// A 1:1 through the original field is unchanged.
	if code, body := as("POST", "/api/v1/calls/direct", map[string]any{"peerId": b}); code != 201 {
		t.Errorf("1:1 = %d %s", code, body)
	}
}

func TestHostLeavingAConferenceOverHTTPKeepsItGoing(t *testing.T) {
	f := newHTTPFixture(t)
	host, b, c, _ := f.org4()
	as := f.as(host, f.org)

	_, body := as("POST", "/api/v1/calls/direct", map[string]any{"peerIds": []string{b, c}})
	call := decode[callResp](t, body)
	for _, u := range []string{host, b, c} {
		f.exec(`UPDATE call_participants SET joined_at = now() WHERE call_id = $1 AND user_id = $2`, call.ID, u)
	}
	if code, body := as("POST", "/api/v1/calls/"+call.ID+"/leave", nil); code != 204 {
		t.Fatalf("host leave = %d %s", code, body)
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE id = $1 AND status = 'LIVE'`, call.ID); n != 1 {
		t.Fatal("the host leaving ended a conference that still had two people in it")
	}
	if n := f.count(`SELECT count(*) FROM outbox WHERE payload->>'type' = 'call.ended' AND payload->>'callId' = $1`, call.ID); n != 0 {
		t.Fatal("call.ended was announced for a conference that carried on")
	}
	if n := f.count(`SELECT count(*) FROM outbox WHERE payload->>'type' = 'call.participant_left' AND payload->>'callId' = $1`, call.ID); n != 1 {
		t.Fatalf("the host's departure was announced %d time(s), want once", n)
	}
}

// The full lifecycle through the real server, including the background
// sweeper: everyone leaves an active conference, it stands immediately
// (nothing in the HTTP path ends it synchronously), and the running
// sweepOverdueCalls — the SAME loop RunCallSweeper ticks — is what closes it
// once the grace period has genuinely passed, with the usual call.ended
// side effects (outbox event, roster told).
func TestConferenceIsClosedBySweeperNotByTheLastLeaveOverHTTP(t *testing.T) {
	f := newHTTPFixture(t)
	host, b, c, _ := f.org4()
	as := f.as(host, f.org)

	_, body := as("POST", "/api/v1/calls/direct", map[string]any{"peerIds": []string{b, c}})
	call := decode[callResp](t, body)
	for _, u := range []string{host, b, c} {
		f.exec(`UPDATE call_participants SET joined_at = now() WHERE call_id = $1 AND user_id = $2`, call.ID, u)
	}
	for _, u := range []string{host, b, c} {
		if code, body := f.as(u, f.org)("POST", "/api/v1/calls/"+call.ID+"/leave", nil); code != 204 {
			t.Fatalf("%s leave = %d %s", u, code, body)
		}
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE id = $1 AND status = 'LIVE'`, call.ID); n != 1 {
		t.Fatal("the last leave ended the conference synchronously over HTTP")
	}
	// Too soon: the running sweeper must leave a freshly-emptied conference
	// alone until ConferenceEmptyGracePeriod has actually elapsed.
	f.srv.sweepOverdueCalls(context.Background())
	if n := f.count(`SELECT count(*) FROM calls WHERE id = $1 AND status = 'LIVE'`, call.ID); n != 1 {
		t.Fatal("the sweeper ended a conference before its grace period elapsed")
	}

	f.exec(`UPDATE call_participants SET left_at = left_at - $2::interval WHERE call_id = $1`,
		call.ID, store.ConferenceEmptyGracePeriod+time.Second)
	f.srv.sweepOverdueCalls(context.Background())

	if n := f.count(`SELECT count(*) FROM calls WHERE id = $1 AND status = 'ENDED'`, call.ID); n != 1 {
		t.Fatal("the running sweeper did not close a conference that has been empty past its grace period")
	}
	if n := f.count(`SELECT count(*) FROM outbox WHERE payload->>'type' = 'call.ended' AND payload->>'callId' = $1`, call.ID); n != 1 {
		t.Fatal("the sweeper's close did not announce call.ended")
	}
}
