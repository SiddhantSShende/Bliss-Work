package api

// Live Meetings and the token gate agree, through the real router.
//
// See meeting_series_http_db_test.go for how to run this
// (MESSAGING_API_TEST_DATABASE_URL, a non-superuser role).
//
// What this locks in: a call that is over — whatever the table's status column
// still says — is neither listed as LIVE nor admitted to the call room, and the
// client is told so with a 409 `call_ended` it can word properly, instead of the
// unexplained 403 it used to get. A real 403 (not in the channel) stays a 403.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/livekit"
)

func (f *httpFixture) withSFU() {
	f.t.Helper()
	lk, err := livekit.New("devkey", strings.Repeat("s", 32), "wss://sfu.test", livekit.MinterOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	f.srv.livekit = lk
}

// channelCall seeds a CHANNEL call in f.channel with its host seated.
func (f *httpFixture) channelCall(status, startedAgo, endsAtOffset string) string {
	f.t.Helper()
	id := uuid.NewString()
	ends := "NULL"
	if endsAtOffset != "" {
		ends = "now() + interval '" + endsAtOffset + "'"
	}
	f.exec(`INSERT INTO calls (id, org_id, kind, channel_id, title, created_by, scheduled_at, started_at, ends_at, status, created_at)
	        VALUES ($1, $2, 'CHANNEL', $3, 'authority', $4,
	                now() - interval '`+startedAgo+`', now() - interval '`+startedAgo+`', `+ends+`, $5,
	                now() - interval '`+startedAgo+`')`,
		id, f.org, f.channel, f.host, status)
	f.exec(`INSERT INTO call_participants (call_id, user_id, org_id, role)
	        VALUES ($1, $2, $3, 'HOST')`, id, f.host, f.org)
	return id
}

func listedCalls(t *testing.T, f *httpFixture, user string) map[string]string {
	t.Helper()
	code, body := f.as(user, f.org)("GET", "/api/v1/calls", nil)
	if code != 200 {
		t.Fatalf("GET /calls = %d: %s", code, body)
	}
	var rows []struct{ ID, Status string }
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	out := map[string]string{}
	for _, r := range rows {
		out[r.ID] = r.Status
	}
	return out
}

func TestLiveMeetingsListAndTokenGateAgreeOnWhatIsOver(t *testing.T) {
	f := newHTTPFixture(t)
	f.withSFU()
	active := f.channelCall("LIVE", "10 minutes", "1 hour")
	lapsed := f.channelCall("LIVE", "3 hours", "-1 hour") // still LIVE in the table, end time gone by
	ended := f.channelCall("ENDED", "3 hours", "-2 hours")

	// A user who got the call onto their roster, then left the channel.
	f.exec(`INSERT INTO call_participants (call_id, user_id, org_id, role)
	        VALUES ($1, $2, $3, 'PARTICIPANT')`, active, f.rival, f.org)

	list := listedCalls(t, f, f.host)
	if list[active] != "LIVE" {
		t.Errorf("active call listed as %q, want LIVE", list[active])
	}
	for name, id := range map[string]string{"lapsed": lapsed, "ended": ended} {
		if list[id] == "LIVE" || list[id] == "SCHEDULED" {
			t.Errorf("%s call is listed as %q — it must never be offered as live or upcoming", name, list[id])
		}
	}

	tokenOf := func(user, id string) (int, map[string]any) {
		code, body := f.as(user, f.org)("POST", "/api/v1/calls/"+id+"/token", map[string]any{})
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		return code, m
	}

	// Active meetings continue to work normally.
	if code, m := tokenOf(f.host, active); code != 200 || m["token"] == "" || m["state"] != "JOINED" {
		t.Fatalf("active call token = %d %v, want 200 JOINED with a token", code, m)
	}
	// Over, however the row looks: 409 call_ended, no token.
	for name, id := range map[string]string{"lapsed": lapsed, "ended": ended} {
		code, m := tokenOf(f.host, id)
		errBody, _ := m["error"].(map[string]any)
		if code != 409 || errBody["code"] != "call_ended" {
			t.Errorf("%s call token = %d %v, want 409 call_ended", name, code, m)
		}
		if _, leaked := m["token"]; leaked {
			t.Errorf("%s call minted a token", name)
		}
	}
	// Authorization is untouched: someone who is not in the channel is refused.
	if code, _ := tokenOf(f.rival, active); code != 403 {
		t.Errorf("non-member token = %d, want 403", code)
	}
	// ...and an active call they cannot enter is not offered to them as joinable.
	if st := listedCalls(t, f, f.rival)[active]; st == "LIVE" || st == "SCHEDULED" {
		t.Errorf("a call the caller cannot enter is listed to them as %q", st)
	}
}
