package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
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

func TestChannelAddedTextIncludesActorAndChannel(t *testing.T) {
	if got, want := channelAddedText("Jordan Doe", "project room"), "Jordan Doe added you to the channel project room"; got != want {
		t.Fatalf("channelAddedText() = %q, want %q", got, want)
	}
	if got, want := channelAddedText("Jordan Doe", ""), "Jordan Doe added you to a channel"; got != want {
		t.Fatalf("channelAddedText() without channel = %q, want %q", got, want)
	}
	if got, want := channelAddedText("", "project room"), "You were added to #project room"; got != want {
		t.Fatalf("legacy channelAddedText() = %q, want %q", got, want)
	}
}

func TestChannelCreatedTextIncludesActorAndChannel(t *testing.T) {
	if got, want := channelCreatedText("Mayank", "Engineering"), "Mayank created the channel Engineering"; got != want {
		t.Fatalf("channelCreatedText() = %q, want %q", got, want)
	}
	if got, want := channelCreatedText("", ""), "Someone created a channel"; got != want {
		t.Fatalf("channelCreatedText() without names = %q, want %q", got, want)
	}
}

func TestTaskAssignedTextIncludesSenderAndTitle(t *testing.T) {
	if got, want := taskAssignedText("Mayank", "Prepare release notes"), "New task from Mayank: Prepare release notes"; got != want {
		t.Fatalf("taskAssignedText() = %q, want %q", got, want)
	}
	if got, want := taskAssignedText("", ""), "New task from Someone"; got != want {
		t.Fatalf("taskAssignedText() without names = %q, want %q", got, want)
	}
}

func TestMessageCreatedSuppressesSelfMailAndSystemMessages(t *testing.T) {
	c := newTestConsumer()
	orgID, userID := uuid.NewString(), uuid.NewString()
	cases := []struct {
		name string
		ev   events.MessageCreated
	}{
		{
			name: "self message",
			ev: events.MessageCreated{
				Type: events.TypeMessageCreated, EventID: uuid.NewString(), OrgID: orgID,
				SenderID: userID, RecipientID: userID,
			},
		},
		{
			name: "mail thread",
			ev: events.MessageCreated{
				Type: events.TypeMessageCreated, EventID: uuid.NewString(), OrgID: orgID,
				SenderID: uuid.NewString(), RecipientID: userID, Origin: "mail",
			},
		},
		{
			name: "system message",
			ev: events.MessageCreated{
				Type: events.TypeMessageCreated, EventID: uuid.NewString(), OrgID: orgID,
				SenderID: uuid.NewString(), RecipientID: userID, Kind: "call_missed",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value, err := json.Marshal(tc.ev)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if err := c.messageCreated(context.Background(), nil, value); err != nil {
				t.Fatalf("messageCreated() = %v, want nil", err)
			}
		})
	}
}

func TestMessagePreviewRemovesStructuredPayloadAndBoundsText(t *testing.T) {
	if got, want := messagePreview("Hello\x1f{\"kind\":\"media\"}"), "Hello"; got != want {
		t.Fatalf("messagePreview() = %q, want %q", got, want)
	}
	if got, want := messagePreview("\x1f{\"kind\":\"fileOffer\"}"), "Sent an attachment"; got != want {
		t.Fatalf("empty messagePreview() = %q, want %q", got, want)
	}
	if got := messagePreview(strings.Repeat("a", 160)); len([]rune(got)) != 140 || !strings.HasSuffix(got, "…") {
		t.Fatalf("long message preview length/content = %d/%q", len([]rune(got)), got)
	}
}
