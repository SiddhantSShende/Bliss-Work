package api

// B-MSG-6: createChannel / addChannelMembers refuse an unbounded memberIds list
// with a 400, through the real router. Opt-in via MESSAGING_API_TEST_DATABASE_URL
// (a non-superuser role); see meeting_series_http_db_test.go's header.

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func randomUUIDs(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = uuid.NewString()
	}
	return out
}

func TestChannelMemberIDsAreCappedPerRequest(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)

	// Over the cap: refused before any work is done.
	code, body := host(http.MethodPost, "/api/v1/channels", map[string]any{
		"name": "too-many", "memberIds": randomUUIDs(maxCreateChannelMembers + 1)})
	if code != http.StatusBadRequest {
		t.Fatalf("create over cap = %d %s, want 400", code, body)
	}
	// At the cap: passes validation. The ids belong to nobody in this org, so the
	// store refuses them (403) — which is how this tells "got past the cap" apart.
	code, body = host(http.MethodPost, "/api/v1/channels", map[string]any{
		"name": "at-cap", "memberIds": randomUUIDs(maxCreateChannelMembers)})
	if code != http.StatusForbidden {
		t.Fatalf("create at cap = %d %s, want 403 (past validation, ids not in org)", code, body)
	}

	code, body = host(http.MethodPost, "/api/v1/channels", map[string]any{"name": "roomy", "memberIds": []string{f.ada}})
	if code != http.StatusCreated {
		t.Fatalf("create channel = %d %s", code, body)
	}
	ch := decode[struct {
		ID string `json:"id"`
	}](t, body)

	code, body = host(http.MethodPost, "/api/v1/channels/"+ch.ID+"/members", map[string]any{
		"memberIds": randomUUIDs(maxAddChannelMembersPerRequest + 1)})
	if code != http.StatusBadRequest {
		t.Fatalf("add over cap = %d %s, want 400", code, body)
	}
	code, body = host(http.MethodPost, "/api/v1/channels/"+ch.ID+"/members", map[string]any{
		"memberIds": randomUUIDs(maxAddChannelMembersPerRequest)})
	if code != http.StatusForbidden {
		t.Fatalf("add at cap = %d %s, want 403 (past validation, ids not in org)", code, body)
	}
	// An ordinary add still works.
	code, body = host(http.MethodPost, "/api/v1/channels/"+ch.ID+"/members", map[string]any{"memberIds": []string{f.grace}})
	if code != http.StatusNoContent {
		t.Fatalf("add one = %d %s, want 204", code, body)
	}
}
