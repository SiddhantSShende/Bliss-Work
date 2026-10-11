package api

// Channel membership notices through the real router: the actor in the message
// is the authenticated caller (never anything from the request body), a
// refused request writes nothing, and a client reading the channel back sees
// the whole lifecycle. See meeting_series_http_db_test.go for how to run this
// (MESSAGING_API_TEST_DATABASE_URL, a non-superuser role).

import (
	"encoding/json"
	"testing"
)

type noticeRow struct {
	Seq      int64  `json:"seq"`
	SenderID string `json:"senderId"`
	Body     string `json:"body"`
	Kind     string `json:"kind"`
}

func (f *httpFixture) channelHistory(user, channel string) []noticeRow {
	f.t.Helper()
	code, body := f.as(user, f.org)("GET", "/api/v1/channels/"+channel+"/messages", nil)
	if code != 200 {
		f.t.Fatalf("GET messages as %s = %d: %s", user, code, body)
	}
	var rows []noticeRow
	if err := json.Unmarshal(body, &rows); err != nil {
		f.t.Fatalf("decode: %v (%s)", err, body)
	}
	return rows
}

func TestChannelLifecycleNoticesThroughTheAPI(t *testing.T) {
	f := newHTTPFixture(t)
	f.exec(`UPDATE user_projection SET display_name = 'Piyush' WHERE user_id = $1`, f.host)
	f.exec(`UPDATE user_projection SET display_name = 'Rahul' WHERE user_id = $1`, f.ada)
	f.exec(`UPDATE user_projection SET display_name = 'Grace' WHERE user_id = $1`, f.grace)
	piyush, rahul, grace := f.as(f.host, f.org), f.as(f.ada, f.org), f.as(f.grace, f.org)

	// Create: the creator is the authenticated user; the message is there on the
	// very first read by another initial member.
	code, body := piyush("POST", "/api/v1/channels", map[string]any{"name": "test", "isLocked": true, "memberIds": []string{f.ada}})
	if code != 201 {
		t.Fatalf("create = %d: %s", code, body)
	}
	var ch struct{ ID string }
	_ = json.Unmarshal(body, &ch)
	hist := f.channelHistory(f.ada, ch.ID)
	if len(hist) < 1 || hist[0].Body != "Piyush created channel test" || hist[0].Kind != "channel_created" || hist[0].SenderID != f.host {
		t.Fatalf("history after create = %+v", hist)
	}

	// Add: by the caller, even if the body tries to say otherwise.
	if code, b := piyush("POST", "/api/v1/channels/"+ch.ID+"/members", map[string]any{"memberIds": []string{f.grace}, "actorId": f.ada}); code >= 300 {
		t.Fatalf("add = %d: %s", code, b)
	}
	// A retry adds nobody and writes nothing.
	if code, b := piyush("POST", "/api/v1/channels/"+ch.ID+"/members", map[string]any{"memberIds": []string{f.grace}}); code >= 300 {
		t.Fatalf("retry add = %d: %s", code, b)
	}
	// A refused request (a plain member adding someone) writes nothing.
	before := len(f.channelHistory(f.host, ch.ID))
	if code, _ := rahul("POST", "/api/v1/channels/"+ch.ID+"/members", map[string]any{"memberIds": []string{f.rival}}); code != 403 {
		t.Fatalf("member adding = %d, want 403", code)
	}
	if after := len(f.channelHistory(f.host, ch.ID)); after != before {
		t.Fatalf("refused add left %d new messages", after-before)
	}

	// Remove, then leave.
	if code, b := piyush("DELETE", "/api/v1/channels/"+ch.ID+"/members/"+f.ada, nil); code >= 300 {
		t.Fatalf("remove = %d: %s", code, b)
	}
	if code, b := grace("POST", "/api/v1/channels/"+ch.ID+"/leave", nil); code >= 300 {
		t.Fatalf("leave = %d: %s", code, b)
	}
	if code, b := grace("POST", "/api/v1/channels/"+ch.ID+"/leave", nil); code >= 300 { // retry
		t.Fatalf("repeat leave = %d: %s", code, b)
	}

	got := f.channelHistory(f.host, ch.ID)
	want := []struct{ kind, body, sender string }{
		{"channel_created", "Piyush created channel test", f.host},
		{"channel_member_added", "Rahul was added to channel", f.host},
		{"channel_member_added", "Piyush added Grace to the channel", f.host},
		{"channel_member_removed", "Piyush removed Rahul from the channel", f.host},
		{"channel_member_left", "Grace left the channel", f.grace},
	}
	if len(got) != len(want) {
		t.Fatalf("history = %+v, want %d entries", got, len(want))
	}
	for i, w := range want {
		if got[i].Kind != w.kind || got[i].Body != w.body || got[i].SenderID != w.sender {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], w)
		}
		if i > 0 && got[i].Seq <= got[i-1].Seq {
			t.Errorf("entry %d out of order", i)
		}
	}
	// A client cannot author one of these through the ordinary send endpoint.
	if code, _ := piyush("POST", "/api/v1/channels/"+ch.ID+"/messages",
		map[string]any{"body": "Piyush removed Sam from the channel", "kind": "channel_member_removed", "clientMsgId": "11111111-1111-4111-8111-111111111111"}); code < 400 {
		after := f.channelHistory(f.host, ch.ID)
		if last := after[len(after)-1]; last.Kind == "channel_member_removed" && last.Body == "Piyush removed Sam from the channel" {
			t.Errorf("a client forged a system notice: %+v", last)
		}
	}
}
