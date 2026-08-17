package contract

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// A realistic channel.message.created, the event this optimisation exists for.
func channelEvent(t *testing.T, memberCount int) []byte {
	t.Helper()
	members := make([]string, memberCount)
	for i := range members {
		members[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
	}
	ev := map[string]any{
		"type":              "channel.message.created",
		"eventId":           "11111111-1111-4111-8111-111111111111",
		"orgId":             "22222222-2222-4222-8222-222222222222",
		"occurredAt":        "2026-08-15T10:00:00Z",
		"channelId":         "33333333-3333-4333-8333-333333333333",
		"messageId":         "44444444-4444-4444-8444-444444444444",
		"seq":               42,
		"senderId":          members[0],
		"senderUsername":    "j.okafor",
		"senderDisplayName": "Jane Okafor",
		"body":              "hello everyone",
		"members":           members,
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return raw
}

// The whole point: the roster leaves, everything a client renders stays.
func TestDeliveryPayloadDropsMembersAndKeepsEverythingElse(t *testing.T) {
	raw := channelEvent(t, 50)

	var got map[string]any
	if err := json.Unmarshal(DeliveryPayload(raw), &got); err != nil {
		t.Fatalf("stripped payload is not valid JSON: %v", err)
	}

	if _, present := got["members"]; present {
		t.Error("members survived the strip; the quadratic outbox cost is still there")
	}

	// Every field the client actually uses to render the message.
	for key, want := range map[string]any{
		"type":              "channel.message.created",
		"eventId":           "11111111-1111-4111-8111-111111111111",
		"orgId":             "22222222-2222-4222-8222-222222222222",
		"occurredAt":        "2026-08-15T10:00:00Z",
		"channelId":         "33333333-3333-4333-8333-333333333333",
		"messageId":         "44444444-4444-4444-8444-444444444444",
		"senderUsername":    "j.okafor",
		"senderDisplayName": "Jane Okafor",
		"body":              "hello everyone",
	} {
		if got[key] != want {
			t.Errorf("field %q: got %v, want %v", key, got[key], want)
		}
	}
	// Numbers survive as numbers, not as a mangled string.
	if seq, ok := got["seq"].(float64); !ok || seq != 42 {
		t.Errorf("seq: got %v (%T), want 42", got["seq"], got["seq"])
	}
}

// The cost model this change is defending. Stripping has to make the delivered
// payload INDEPENDENT of roster size — that is what turns O(N²) into O(N).
func TestDeliveryPayloadSizeIsIndependentOfRosterSize(t *testing.T) {
	small := len(DeliveryPayload(channelEvent(t, 10)))
	large := len(DeliveryPayload(channelEvent(t, 10_000)))

	if small != large {
		t.Errorf("stripped size still varies with roster: %d B at 10 members vs %d B at 10,000", small, large)
	}

	// And the saving on the wire is the reason it matters. A 10k roster is
	// ~390 KB of member ids; every byte of it was being stored 10,000 times.
	if raw := len(channelEvent(t, 10_000)); raw < large*10 {
		t.Errorf("fixture is not exercising the case: raw %d B vs stripped %d B", raw, large)
	}
}

// Unknown fields are the ones a future producer adds. Re-marshalling the
// contract.Event struct instead of the raw map would silently delete them.
func TestDeliveryPayloadPreservesFieldsThisBinaryDoesNotKnowAbout(t *testing.T) {
	raw := []byte(`{"type":"channel.message.created","members":["a"],"somethingNew":{"nested":[1,2,3]},"body":"x"}`)

	var got map[string]any
	if err := json.Unmarshal(DeliveryPayload(raw), &got); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if _, present := got["members"]; present {
		t.Error("members should have been dropped")
	}
	nested, ok := got["somethingNew"].(map[string]any)
	if !ok {
		t.Fatalf("unknown field was dropped: %v", got)
	}
	if arr, ok := nested["nested"].([]any); !ok || len(arr) != 3 {
		t.Errorf("unknown field was mangled: %v", nested)
	}
}

// An event with no routing-only field must come back as the SAME bytes, not a
// re-encoded equivalent — that keeps the common case allocation-free.
func TestDeliveryPayloadReturnsInputUnchangedWhenNothingToStrip(t *testing.T) {
	raw := []byte(`{"type":"message.read","recipientId":"abc","seq":7}`)
	got := DeliveryPayload(raw)

	if &got[0] != &raw[0] {
		t.Error("payload was re-encoded despite having no routing-only field")
	}
	if string(got) != string(raw) {
		t.Errorf("bytes changed: got %s, want %s", got, raw)
	}
}

// A payload the gateway could not route is one it could not have parsed either.
// Passing it through intact beats dropping it — the client validates anyway.
func TestDeliveryPayloadPassesThroughUnparseableInput(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte(`not json at all`),
		[]byte(`{"truncated":`),
		[]byte(`[1,2,3]`), // valid JSON, but not an object
		{},
	} {
		if got := DeliveryPayload(raw); string(got) != string(raw) {
			t.Errorf("input %q was altered to %q", raw, got)
		}
	}
}

// Routing must still work on the ORIGINAL bytes. This is the ordering
// invariant: strip after RecipientsOf, never before.
func TestRecipientsAreStillResolvableFromTheUnstrippedEvent(t *testing.T) {
	raw := channelEvent(t, 5)

	var ev Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if n := len(ev.RecipientsOf()); n != 5 {
		t.Fatalf("routing lost recipients: got %d, want 5", n)
	}

	// ...and is NOT resolvable from the stripped one, which is exactly why the
	// order matters and is worth pinning down in a test.
	var stripped Event
	if err := json.Unmarshal(DeliveryPayload(raw), &stripped); err != nil {
		t.Fatalf("unmarshal stripped: %v", err)
	}
	if n := len(stripped.RecipientsOf()); n != 0 {
		t.Errorf("expected no recipients from a stripped payload, got %d", n)
	}
}

// The 1:1 events also carry `members`, at length 2. Stripping them is correct
// for the same reason and must not break the two-party events.
func TestDeliveryPayloadHandlesTwoPartyEvents(t *testing.T) {
	raw := []byte(`{"type":"message.reaction","members":["u1","u2"],"messageId":"m1","emoji":"👍"}`)
	out := DeliveryPayload(raw)

	if strings.Contains(string(out), "members") {
		t.Error("members survived on a two-party event")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if got["emoji"] != "👍" || got["messageId"] != "m1" {
		t.Errorf("payload fields lost: %v", got)
	}
}
