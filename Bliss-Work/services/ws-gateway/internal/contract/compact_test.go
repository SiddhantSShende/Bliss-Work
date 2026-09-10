package contract

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestTryCompact_MessageCreatedRoundTrips(t *testing.T) {
	eid := uuid.New().String()
	mid := uuid.New().String()
	ev := &Event{Type: "message.created", EventID: eid, MessageID: mid}
	raw := []byte(`{"type":"message.created","eventId":"` + eid + `","messageId":"` + mid + `"}`)

	got := TryCompact(ev, DeliveryPayload(raw))

	if !IsCompactRef(got) {
		t.Fatalf("expected a compact reference, got %d bytes: %x", len(got), got)
	}
	gotEID, gotMID, ok := DecodeCompactRef(got)
	if !ok {
		t.Fatalf("DecodeCompactRef failed on a value IsCompactRef accepted")
	}
	if gotEID != eid {
		t.Errorf("eventId round-trip: got %q want %q", gotEID, eid)
	}
	if gotMID != mid {
		t.Errorf("messageId round-trip: got %q want %q", gotMID, mid)
	}
}

func TestTryCompact_OtherEventTypesPassThrough(t *testing.T) {
	stripped := DeliveryPayload([]byte(`{"type":"message.read","eventId":"x"}`))
	for _, typ := range []string{"message.read", "message.delivered", "task.assigned", "channel.message.created", ""} {
		ev := &Event{Type: typ, EventID: uuid.New().String(), MessageID: uuid.New().String()}
		got := TryCompact(ev, stripped)
		if string(got) != string(stripped) {
			t.Errorf("type %q: expected passthrough of stripped payload, got a different value", typ)
		}
		if IsCompactRef(got) {
			t.Errorf("type %q: full JSON was misidentified as a compact reference", typ)
		}
	}
}

func TestTryCompact_MissingOrInvalidUUIDsFallThrough(t *testing.T) {
	stripped := []byte(`{"type":"message.created"}`)
	cases := []*Event{
		{Type: "message.created", EventID: "", MessageID: uuid.New().String()},
		{Type: "message.created", EventID: uuid.New().String(), MessageID: ""},
		{Type: "message.created", EventID: "not-a-uuid", MessageID: uuid.New().String()},
	}
	for i, ev := range cases {
		got := TryCompact(ev, stripped)
		if string(got) != string(stripped) {
			t.Errorf("case %d: expected fallthrough to stripped payload, got compact form", i)
		}
	}
}

func TestIsCompactRef_NeverMatchesJSON(t *testing.T) {
	// Every event type this codebase produces serializes as a JSON object, so
	// the first byte is always '{' (0x7B) — the compact marker (0x01) must
	// never collide with that, or a legacy/other-type outbox member would be
	// misread as a reference on replay.
	samples := [][]byte{
		[]byte(`{}`),
		[]byte(`{"type":"message.read"}`),
		[]byte(`{"type":"message.created","body":"hello"}`),
	}
	for _, s := range samples {
		if IsCompactRef(s) {
			t.Errorf("plain JSON misidentified as a compact reference: %s", s)
		}
	}
}

func TestDecodeCompactRef_RejectsWrongLength(t *testing.T) {
	if _, _, ok := DecodeCompactRef([]byte{compactRefMarker, 1, 2, 3}); ok {
		t.Error("expected DecodeCompactRef to reject a short/malformed record")
	}
	if _, _, ok := DecodeCompactRef(nil); ok {
		t.Error("expected DecodeCompactRef to reject a nil record")
	}
}

// Compact records must remain unambiguously smaller than any real event
// payload this outbox stores, and must marshal/unmarshal as raw bytes when
// passed through a JSON-array response the way delivery paths sometimes do
// (sanity check only — the outbox itself stores raw []byte via Redis, not
// JSON-wrapped).
func TestCompactRefLength(t *testing.T) {
	ev := &Event{Type: "message.created", EventID: uuid.New().String(), MessageID: uuid.New().String()}
	got := TryCompact(ev, []byte(`{"type":"message.created"}`))
	if len(got) != compactRefLen {
		t.Fatalf("compact ref length = %d, want %d", len(got), compactRefLen)
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatalf("compact ref bytes did not marshal: %v", err)
	}
}
