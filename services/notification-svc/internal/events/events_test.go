package events

import (
	"encoding/json"
	"testing"
)

// TestTopicConstants pins the canonical Kafka topic names. These are a
// cross-service contract: a silent typo here would route notifications to a
// dead topic that no producer/consumer agrees on, with no compile error.
func TestTopicConstants(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"task topic", TopicTask, "task.events.v1"},
		{"notification topic", TopicNotification, "notification.events.v1"},
		{"dlq topic", TopicNotificationDLQ, "notification.events.v1.dlq"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("%s = %q, want %q", tc.name, tc.got, tc.want)
			}
		})
	}
}

// TestDLQTopicDerivesFromNotificationTopic documents the invariant that the
// dead-letter topic mirrors the notification stream with a `.dlq` suffix.
func TestDLQTopicDerivesFromNotificationTopic(t *testing.T) {
	if want := TopicNotification + ".dlq"; TopicNotificationDLQ != want {
		t.Errorf("TopicNotificationDLQ = %q, want %q (mirror of notification topic)", TopicNotificationDLQ, want)
	}
}

// TestTypeAndKindConstants pins the event-type discriminants and notification
// kinds used by the consumer's routing switch. They are part of the wire
// contract, so changing one is a breaking change that this test surfaces.
func TestTypeAndKindConstants(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"type acknowledged", TypeTaskAcknowledged, "task.acknowledged"},
		{"type completed", TypeTaskCompleted, "task.completed"},
		{"type notification.created", TypeNotificationCreated, "notification.created"},
		{"kind acknowledged", KindTaskAcknowledged, "TASK_ACKNOWLEDGED"},
		{"kind completed", KindTaskCompleted, "TASK_COMPLETED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("%s = %q, want %q", tc.name, tc.got, tc.want)
			}
		})
	}
}

// TestTaskEvent_UnmarshalsContractFields verifies the JSON tags on the consumed
// TaskEvent: an incoming task.events.v1 record must populate the fields the
// consumer reads (type, eventId, orgId, taskId, senderId, assigneeUsername).
// A mismatched tag would silently zero a field used to build the notification.
func TestTaskEvent_UnmarshalsContractFields(t *testing.T) {
	raw := []byte(`{
		"type": "task.completed",
		"eventId": "e1",
		"orgId": "o1",
		"occurredAt": "2026-06-24T00:00:00.000Z",
		"taskId": "t1",
		"assigneeId": "a1",
		"senderId": "s1",
		"statusVersion": 7,
		"assigneeUsername": "alice"
	}`)

	var ev TaskEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	want := TaskEvent{
		Type:             "task.completed",
		EventID:          "e1",
		OrgID:            "o1",
		OccurredAt:       "2026-06-24T00:00:00.000Z",
		TaskID:           "t1",
		AssigneeID:       "a1",
		SenderID:         "s1",
		StatusVersion:    7,
		AssigneeUsername: "alice",
	}
	if ev != want {
		t.Errorf("decoded = %+v, want %+v", ev, want)
	}
}

// TestNotificationCreated_OmitsNilTaskID checks the `taskId,omitempty` tag: a
// notification with no task must serialize without a taskId key (not as
// "taskId": null), and one with a task must include it. Consumers of
// notification.events.v1 distinguish task vs. non-task notifications on this.
func TestNotificationCreated_OmitsNilTaskID(t *testing.T) {
	t.Run("nil taskId omitted", func(t *testing.T) {
		nc := NotificationCreated{Type: TypeNotificationCreated, EventID: "x", TaskID: nil}
		b, err := json.Marshal(nc)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, present := m["taskId"]; present {
			t.Errorf("taskId key present for nil TaskID; want omitted. json=%s", b)
		}
	})

	t.Run("set taskId present", func(t *testing.T) {
		id := "t-42"
		nc := NotificationCreated{Type: TypeNotificationCreated, EventID: "x", TaskID: &id}
		b, err := json.Marshal(nc)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got, _ := m["taskId"].(string); got != id {
			t.Errorf("taskId = %v, want %q. json=%s", m["taskId"], id, b)
		}
	})
}
