package contract

import "testing"

// TestFanoutTopics_IncludesIntegrationEvents is a regression test for the gap
// found in the audit: integrations-svc has produced integration.activity.
// created onto integration.events.v1 since its initial commit, but this
// topic was never in FanoutTopics, so ws-gateway's Kafka reader (built from
// GroupTopics: contract.FanoutTopics, see internal/fanout.New) never
// subscribed to it at all — the event published successfully once the topic
// itself existed on the broker, but reached no client regardless of what
// RecipientsOf said, silently.
func TestFanoutTopics_IncludesIntegrationEvents(t *testing.T) {
	for _, want := range []string{"integration.events.v1"} {
		found := false
		for _, got := range FanoutTopics {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("FanoutTopics = %v, missing %q", FanoutTopics, want)
		}
	}
}

// TestRecipientsOf_IntegrationActivityCreated proves the event is routed to
// exactly the account owner it names (RecipientID / JSON "recipientId",
// matching integrations-svc's emit_activity_created) — the same single-
// recipient shape as notification.created and task.assigned — and to nobody
// else. This is a private per-user signal (a connected mailbox/chat account
// syncing), so leaking it to Members/SenderID/UserID the way a channel event
// would be routed is the wrong failure mode, not just an unrouted one.
func TestRecipientsOf_IntegrationActivityCreated(t *testing.T) {
	ev := &Event{
		Type:        "integration.activity.created",
		EventID:     "evt-1",
		RecipientID: "user-owner",
		// Populated to prove they are ignored for this event type, not just
		// absent from the test fixture.
		SenderID: "user-other",
		UserID:   "user-other-2",
		Members:  []string{"user-other", "user-other-2", "user-owner"},
	}

	got := ev.RecipientsOf()
	if len(got) != 1 || got[0] != "user-owner" {
		t.Fatalf("RecipientsOf() = %v, want exactly [\"user-owner\"]", got)
	}
}

// TestRecipientsOf_IntegrationActivityCreated_NoRecipient_DropsCleanly
// mirrors how every other single-recipient case behaves when its id is
// absent (dedupe strips the empty string) — an event.py bug that ever
// produced an empty recipientId must not panic or fan out to everyone.
func TestRecipientsOf_IntegrationActivityCreated_NoRecipient_DropsCleanly(t *testing.T) {
	ev := &Event{Type: "integration.activity.created"}
	if got := ev.RecipientsOf(); len(got) != 0 {
		t.Fatalf("RecipientsOf() with no recipientId = %v, want empty", got)
	}
}

// TestRecipientsOf_StickyPinChanged proves a pin/unpin reaches exactly the user
// whose pin it is (AssigneeID / JSON "assigneeId") and nobody else — their Web
// and Desktop sessions are both that one user, which is the whole sync. The
// other identity fields are populated to prove they are ignored: a pin is
// private, so it must never fan out to the task's sender or co-assignees.
func TestRecipientsOf_StickyPinChanged(t *testing.T) {
	ev := &Event{
		Type:       "sticky.pin.changed",
		EventID:    "evt-1",
		AssigneeID: "user-pinner",
		SenderID:   "user-sender",
		UserID:     "user-other",
		Members:    []string{"user-sender", "user-other", "user-pinner"},
	}
	got := ev.RecipientsOf()
	if len(got) != 1 || got[0] != "user-pinner" {
		t.Fatalf("RecipientsOf() = %v, want exactly [\"user-pinner\"]", got)
	}
}

func TestRecipientsOf_StickyPinChanged_NoAssignee_DropsCleanly(t *testing.T) {
	ev := &Event{Type: "sticky.pin.changed"}
	if got := ev.RecipientsOf(); len(got) != 0 {
		t.Fatalf("RecipientsOf() with no assigneeId = %v, want empty", got)
	}
}
