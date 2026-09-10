package events

import (
	"encoding/json"
	"testing"
)

// TestMailDelivered_SenderIDOmittedWhenEmpty pins the bug this file exists to
// catch: DeliverInboundMail (external mail, no local author) leaves SenderID
// at its Go zero value. The shared TS contract types the field
// `z.string().uuid().optional()`, which accepts an ABSENT key but rejects an
// empty string — so without `omitempty` here, every inbound MailDelivered
// event failed ServerEvent.safeParse() on the client and was silently
// dropped, and an externally-received mail never triggered the client's
// Inbox refetch even though it was correctly stored and delivered.
func TestMailDelivered_SenderIDOmittedWhenEmpty(t *testing.T) {
	inbound := MailDelivered{
		Type:       TypeMailDelivered,
		EventID:    "evt-1",
		OrgID:      "org-1",
		OccurredAt: "2026-01-01T00:00:00.000Z",
		MailID:     "mail-1",
		// SenderID intentionally left unset, as DeliverInboundMail does.
		Members: []string{"user-1"},
	}
	raw, err := json.Marshal(inbound)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, present := m["senderId"]; present {
		t.Errorf("senderId key present for inbound mail (value %q); want it entirely absent, "+
			"or the client-side optional-uuid check rejects it and drops the whole event", m["senderId"])
	}

	// The internal send path (mail_deliver.go) always has a real author — the
	// key must still be present and correct there, unaffected by omitempty.
	internal := inbound
	internal.SenderID = "user-author"
	raw, err = json.Marshal(internal)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m["senderId"] != "user-author" {
		t.Errorf("senderId = %v, want %q", m["senderId"], "user-author")
	}
}
