package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func internalRequest(f *httpFixture, method, path, token string, body any) (int, []byte) {
	f.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		f.t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Internal-Token", token)
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

func TestInternalProjectChannelWritesAreAuthenticatedAndOrgScoped(t *testing.T) {
	f := newHTTPFixture(t)
	previousToken := internalToken
	internalToken = "task-svc-test-secret"
	t.Cleanup(func() { internalToken = previousToken })

	create := map[string]any{
		"orgId": f.org, "name": "Quarterly planning", "isLocked": true,
		"creatorId": f.host, "memberIds": []string{},
	}
	if code, _ := internalRequest(f, http.MethodPost, "/internal/channels", "", create); code != http.StatusUnauthorized {
		t.Fatalf("create without token = %d, want 401", code)
	}
	code, body := internalRequest(f, http.MethodPost, "/internal/channels", internalToken, create)
	if code != http.StatusCreated {
		t.Fatalf("create = %d: %s", code, body)
	}
	var created struct {
		ChannelID string `json:"channelId"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.ChannelID == "" {
		t.Fatalf("create response = %s, err=%v", body, err)
	}
	if got := f.count(`SELECT count(*) FROM channels WHERE id = $1 AND org_id = $2 AND is_locked`, created.ChannelID, f.org); got != 1 {
		t.Fatalf("locked project channel count = %d, want 1", got)
	}

	add := map[string]any{"orgId": f.org, "actorId": f.host, "memberIds": []string{f.ada}}
	path := "/internal/channels/" + created.ChannelID + "/members"
	for i := 0; i < 2; i++ {
		if code, body := internalRequest(f, http.MethodPost, path, internalToken, add); code != http.StatusNoContent {
			t.Fatalf("add attempt %d = %d: %s", i+1, code, body)
		}
	}
	if got := f.count(`SELECT count(*) FROM channel_members WHERE channel_id = $1 AND user_id = $2`, created.ChannelID, f.ada); got != 1 {
		t.Fatalf("member rows after retry = %d, want 1", got)
	}
	if got := f.count(`SELECT count(*) FROM channel_messages WHERE channel_id = $1`, created.ChannelID); got != 2 {
		t.Fatalf("channel messages after idempotent retry = %d, want create + one add notice", got)
	}

	// The internal bypass does not weaken messaging-svc's organization checks.
	crossOrg := map[string]any{"orgId": f.org, "actorId": f.host, "memberIds": []string{f.stranger}}
	if code, body := internalRequest(f, http.MethodPost, path, internalToken, crossOrg); code < 400 {
		t.Fatalf("cross-org member add = %d: %s", code, body)
	}
	if got := f.count(`SELECT count(*) FROM channel_members WHERE channel_id = $1 AND user_id = $2`, created.ChannelID, f.stranger); got != 0 {
		t.Fatalf("cross-org member was added: count=%d", got)
	}
	wrongOrg := map[string]any{"orgId": f.other, "actorId": f.stranger, "memberIds": []string{}}
	if code, body := internalRequest(f, http.MethodPost, path, internalToken, wrongOrg); code != http.StatusNotFound {
		t.Fatalf("cross-org channel add = %d: %s, want 404", code, body)
	}
}
