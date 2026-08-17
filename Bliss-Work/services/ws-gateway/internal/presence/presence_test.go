package presence

import (
	"encoding/json"
	"io"
	"log/slog"
	"testing"
)

// TestSnapshotRaw verifies the presence.snapshot frame matches the shared
// PresenceSnapshot zod schema: envelope (type/eventId/orgId/occurredAt) plus a
// non-null `online` array. A nil slice must serialize to [] (never null) so the
// client's z.array(...) parse never rejects it.
func TestSnapshotRaw(t *testing.T) {
	b := New(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))

	raw, err := b.SnapshotRaw("org-1", nil)
	if err != nil {
		t.Fatalf("SnapshotRaw error: %v", err)
	}

	var got struct {
		Type       string   `json:"type"`
		EventID    string   `json:"eventId"`
		OrgID      string   `json:"orgId"`
		OccurredAt string   `json:"occurredAt"`
		Online     []string `json:"online"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != "presence.snapshot" {
		t.Errorf("type = %q, want presence.snapshot", got.Type)
	}
	if got.EventID == "" || got.OrgID != "org-1" || got.OccurredAt == "" {
		t.Errorf("envelope incomplete: %+v", got)
	}
	if got.Online == nil {
		t.Errorf("online must be [] not null")
	}
}

// TestSnapshotRawPreservesMembers ensures the online set round-trips intact.
func TestSnapshotRawPreservesMembers(t *testing.T) {
	b := New(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	raw, err := b.SnapshotRaw("org-1", []string{"u1", "u2"})
	if err != nil {
		t.Fatalf("SnapshotRaw error: %v", err)
	}
	var got struct {
		Online []string `json:"online"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Online) != 2 || got.Online[0] != "u1" || got.Online[1] != "u2" {
		t.Errorf("online = %v, want [u1 u2]", got.Online)
	}
}
