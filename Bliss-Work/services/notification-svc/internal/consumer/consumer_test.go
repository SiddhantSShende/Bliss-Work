package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/google/uuid"

	"github.com/task-board/notification-svc/internal/events"
)

func newTestConsumer() *Consumer {
	return &Consumer{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// TestCreate_InvalidUUIDFields_AreDeadLetteredNotCrashed is the regression test
// for the crash-loop bug: a well-formed JSON event whose orgId/recipientId/
// taskId is not a UUID used to reach the `uuid`-typed INSERT (see
// 001_init.sql) untouched, which Postgres rejected with 22P02 — an error
// runBatch could not tell apart from a transient DB failure, so it abandoned
// the batch and restarted forever on the same poison offset. create() must
// catch each of these itself and report errMalformed (dead-letter + commit),
// the same path already used for a bad eventId, before ever touching the
// transaction. Passing a nil tx here is deliberate: if the validation ever
// regressed to run after a DB call, this test would panic instead of quietly
// passing.
func TestCreate_InvalidUUIDFields_AreDeadLetteredNotCrashed(t *testing.T) {
	validID := uuid.NewString()
	badTaskID := "not-a-uuid"

	cases := []struct {
		name string
		n    notification
	}{
		{"empty orgId", notification{sourceEventID: validID, orgID: "", recipientID: validID}},
		{"non-uuid orgId", notification{sourceEventID: validID, orgID: "acme-org", recipientID: validID}},
		{"empty recipientId", notification{sourceEventID: validID, orgID: validID, recipientID: ""}},
		{"non-uuid recipientId", notification{sourceEventID: validID, orgID: validID, recipientID: "bob"}},
		{"non-uuid taskId", notification{sourceEventID: validID, orgID: validID, recipientID: validID, taskID: &badTaskID}},
	}

	c := newTestConsumer()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := c.create(context.Background(), nil, tc.n)
			if !errors.Is(err, errMalformed) {
				t.Fatalf("create(%+v) = %v, want errMalformed", tc.n, err)
			}
		})
	}
}

// TestHandle_TaskEvent_InvalidUUIDFields_AreDeadLettered exercises the same
// regression through the public entry point a real Kafka message goes
// through, for the fields TaskEvent contributes to a notification row
// (orgId, senderId → recipient_id, taskId).
func TestHandle_TaskEvent_InvalidUUIDFields_AreDeadLettered(t *testing.T) {
	c := newTestConsumer()
	validID := uuid.NewString()

	cases := []struct {
		name string
		ev   events.TaskEvent
	}{
		{
			"invalid orgId",
			events.TaskEvent{Type: events.TypeTaskAcknowledged, EventID: validID, OrgID: "not-a-uuid", SenderID: validID},
		},
		{
			"invalid senderId",
			events.TaskEvent{Type: events.TypeTaskCompleted, EventID: validID, OrgID: validID, SenderID: "not-a-uuid"},
		},
		{
			"invalid taskId",
			events.TaskEvent{Type: events.TypeTaskIgnored, EventID: validID, OrgID: validID, SenderID: validID, TaskID: "not-a-uuid"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value, err := json.Marshal(tc.ev)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			err = c.handle(context.Background(), nil, value)
			if !errors.Is(err, errMalformed) {
				t.Fatalf("handle(%s) = %v, want errMalformed", tc.name, err)
			}
		})
	}
}

// TestChannelMemberJoined_InvalidUUIDFields_AreDeadLettered is the same
// regression on the second producer of notifications — messaging-svc's
// channel.member.joined, which reaches create() via a different struct
// (ChannelMemberJoined) but the same orgId/recipientId validation.
func TestChannelMemberJoined_InvalidUUIDFields_AreDeadLettered(t *testing.T) {
	c := newTestConsumer()
	validID := uuid.NewString()

	cases := []struct {
		name string
		ev   events.ChannelMemberJoined
	}{
		{
			"invalid orgId",
			events.ChannelMemberJoined{Type: events.TypeChannelMemberJoined, EventID: validID, OrgID: "not-a-uuid", UserID: validID, ActorID: uuid.NewString()},
		},
		{
			"invalid userId",
			events.ChannelMemberJoined{Type: events.TypeChannelMemberJoined, EventID: validID, OrgID: validID, UserID: "not-a-uuid", ActorID: uuid.NewString()},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value, err := json.Marshal(tc.ev)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			err = c.channelMemberJoined(context.Background(), nil, value)
			if !errors.Is(err, errMalformed) {
				t.Fatalf("channelMemberJoined(%s) = %v, want errMalformed", tc.name, err)
			}
		})
	}
}
