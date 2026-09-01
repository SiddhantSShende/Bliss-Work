package emit

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/task-board/sticky-relay/internal/sweep"
)

var at = time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

// The wire shape is a contract with three files that cannot import this one:
// ws-gateway's routing table, its TypeScript mirror, and the client's Zod union.
// A mismatch there is silent — WsClient drops an unparseable frame with only a
// console warning — so it is pinned here, on the producing end.
func TestEventWireShape(t *testing.T) {
	msgs, err := Messages([]sweep.Refresh{{OrgID: "org-1", AssigneeID: "alice", PinCount: 3}}, at)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}

	var got map[string]any
	if err := json.Unmarshal(msgs[0].Value, &got); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}

	want := map[string]any{
		"type":       "sticky.refresh",
		"orgId":      "org-1",
		"assigneeId": "alice",
		"pinCount":   float64(3),
		"occurredAt": "2026-09-01T12:00:00.000Z",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("field %q: got %v, want %v", k, got[k], v)
		}
	}
	if got["eventId"] == "" || got["eventId"] == nil {
		t.Error("eventId must be present — consumers dedupe on it")
	}

	// Exactly these fields. An extra one is a contract change that the three
	// mirroring files will not have been told about.
	if len(got) != len(want)+1 { // +1 for eventId
		t.Errorf("unexpected field set: %v", keys(got))
	}
}

func TestEventCarriesNoTaskContent(t *testing.T) {
	// This path exists to say "look again". Task titles are encrypted at rest
	// for a reason; putting them on a repair broadcast would undo that.
	msgs, _ := Messages([]sweep.Refresh{{OrgID: "o", AssigneeID: "a", PinCount: 1}}, at)
	var got map[string]any
	_ = json.Unmarshal(msgs[0].Value, &got)
	for _, forbidden := range []string{"title", "description", "taskId", "tasks"} {
		if _, present := got[forbidden]; present {
			t.Errorf("event must not carry %q", forbidden)
		}
	}
}

func TestKeyIsTheAssigneeSoNudgesStayOrdered(t *testing.T) {
	// Same-key messages land on one partition, so a person's nudges can never
	// overtake one another.
	msgs, _ := Messages([]sweep.Refresh{{OrgID: "o", AssigneeID: "alice", PinCount: 1}}, at)
	if string(msgs[0].Key) != "alice" {
		t.Errorf("key: got %q, want %q", msgs[0].Key, "alice")
	}
	if msgs[0].Topic != Topic {
		t.Errorf("topic: got %q, want %q", msgs[0].Topic, Topic)
	}
}

func TestEveryEventIDIsUnique(t *testing.T) {
	msgs, _ := Messages([]sweep.Refresh{
		{OrgID: "o", AssigneeID: "alice", PinCount: 1},
		{OrgID: "o", AssigneeID: "bob", PinCount: 1},
	}, at)
	var a, b map[string]any
	_ = json.Unmarshal(msgs[0].Value, &a)
	_ = json.Unmarshal(msgs[1].Value, &b)
	if a["eventId"] == b["eventId"] {
		t.Error("two events shared an id; a deduping consumer would drop one")
	}
}

func TestNoRefreshesPublishesNothing(t *testing.T) {
	msgs, err := Messages(nil, at)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("got %d messages for no refreshes, want 0", len(msgs))
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
