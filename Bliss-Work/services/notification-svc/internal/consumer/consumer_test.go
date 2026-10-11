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
	if got, want := channelCreatedText("Mayank", "Engineering"), "Mayank added you to the new channel Engineering"; got != want {
		t.Fatalf("channelCreatedText() = %q, want %q", got, want)
	}
	if got, want := channelCreatedText("", ""), "Someone added you to a new channel"; got != want {
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

// A nil tx is deliberate in the next two tests: each case must return before
// create() touches the database, so a regression that starts notifying would
// panic here instead of quietly passing.
func TestChannelMemberJoinedSkipsSelfJoinAndUnknownActor(t *testing.T) {
	c := newTestConsumer()
	orgID, userID := uuid.NewString(), uuid.NewString()
	cases := []struct {
		name    string
		actorID string
	}{
		{"self join", userID},
		{"producer without actorId", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value, err := json.Marshal(events.ChannelMemberJoined{
				Type: events.TypeChannelMemberJoined, EventID: uuid.NewString(), OrgID: orgID,
				ChannelID: uuid.NewString(), ChannelName: "project room", UserID: userID, ActorID: tc.actorID,
			})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if err := c.channelMemberJoined(context.Background(), nil, value); err != nil {
				t.Fatalf("channelMemberJoined() = %v, want nil (no notification)", err)
			}
		})
	}
}

// The "<actor> added <user> to the channel" system message is fanned out to the
// whole roster as a channel.message.created event. It must not also become a
// CHANNEL_MESSAGE notification — the added user's single notification is the
// CHANNEL_ADDED row from channel.member.joined.
func TestChannelMessageCreatedIgnoresMemberAddedSystemMessage(t *testing.T) {
	c := newTestConsumer()
	actorID, addedID := uuid.NewString(), uuid.NewString()
	value, err := json.Marshal(events.ChannelMessageCreated{
		Type: events.TypeChannelMessageCreated, EventID: uuid.NewString(), OrgID: uuid.NewString(),
		ChannelID: uuid.NewString(), MessageID: uuid.NewString(), SenderID: actorID,
		ChannelName: "project room", Body: "Jordan Doe added Alex Lee to the channel project room",
		Kind: "channel_member_added", Members: []string{actorID, addedID, uuid.NewString()},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := c.channelMessageCreated(context.Background(), nil, value); err != nil {
		t.Fatalf("channelMessageCreated() = %v, want nil (no notification)", err)
	}
}

func TestCallNoticeClassifiesEachMeetingEvent(t *testing.T) {
	const at = "2026-10-06T09:00:00Z"
	base := events.CallLifecycle{CallID: uuid.NewString(), Kind: "MEETING", Title: "Standup", ScheduledAt: at}
	with := func(f func(*events.CallLifecycle)) events.CallLifecycle {
		ev := base
		f(&ev)
		return ev
	}
	cases := []struct {
		name      string
		ev        events.CallLifecycle
		kind      string
		text      string
		linksCall bool
	}{
		{"scheduled", with(func(e *events.CallLifecycle) { e.Type = events.TypeCallScheduled }),
			events.KindMeetingScheduled, "Meeting scheduled: Standup · " + at, true},
		{"edited", with(func(e *events.CallLifecycle) { e.Type = events.TypeCallScheduled; e.Change = events.CallChangeUpdated }),
			events.KindMeetingUpdated, "Meeting updated: Standup · " + at, true},
		{"invited", with(func(e *events.CallLifecycle) { e.Type = events.TypeCallRing; e.ScheduledAt = "" }),
			events.KindMeetingInvite, "Meeting invitation: Standup", true},
		{"started", with(func(e *events.CallLifecycle) { e.Type = events.TypeCallStarted; e.Status = events.CallStatusLive }),
			events.KindMeetingStarted, "Meeting started: Standup", true},
		{"cancelled", with(func(e *events.CallLifecycle) { e.Type = events.TypeCallEnded; e.Status = events.CallStatusCancelled }),
			events.KindMeetingCancelled, "Meeting cancelled: Standup · " + at, false},
		{"untitled", with(func(e *events.CallLifecycle) {
			e.Type = events.TypeCallStarted
			e.Status = events.CallStatusLive
			e.Title = ""
		}),
			events.KindMeetingStarted, "Meeting started: Meeting", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, text, linksCall := callNotice(tc.ev)
			if kind != tc.kind || text != tc.text || linksCall != tc.linksCall {
				t.Errorf("callNotice() = (%q, %q, %v), want (%q, %q, %v)", kind, text, linksCall, tc.kind, tc.text, tc.linksCall)
			}
		})
	}
}

// Being added to an ad-hoc call (DIRECT, no schedule) is a call notification in call
// words — never a meeting invitation. Anything with a schedule, or any other kind,
// keeps the meeting wording it always had.
func TestCallNoticeWordsAnAdhocRingAsACallNotAMeeting(t *testing.T) {
	ring := func(kind, scheduledAt, actor string) events.CallLifecycle {
		return events.CallLifecycle{
			Type: events.TypeCallRing, CallID: uuid.NewString(), Kind: kind,
			ScheduledAt: scheduledAt, ActorName: actor,
		}
	}
	cases := []struct {
		name string
		ev   events.CallLifecycle
		kind string
		text string
	}{
		{"added to a conference", ring("DIRECT", "", "Jordan Doe"),
			events.KindCallAdded, "Jordan Doe added you to a conference call"},
		{"adder not resolvable", ring("DIRECT", "", ""),
			events.KindCallAdded, "You were added to a conference call"},
		{"a titled ad-hoc call is still a call", func() events.CallLifecycle {
			e := ring("DIRECT", "", "Jordan Doe")
			e.Title = "Standup"
			return e
		}(), events.KindCallAdded, "Jordan Doe added you to a conference call"},
		{"scheduled direct call keeps meeting wording", ring("DIRECT", "2026-10-06T09:00:00Z", "Jordan Doe"),
			events.KindMeetingInvite, "Meeting scheduled: Meeting · 2026-10-06T09:00:00Z"},
		{"a meeting still invites", ring("MEETING", "", "Jordan Doe"),
			events.KindMeetingInvite, "Meeting invitation: Meeting"},
		{"a channel call still invites", ring("CHANNEL", "", "Jordan Doe"),
			events.KindMeetingInvite, "Meeting invitation: Meeting"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, text, linksCall := callNotice(tc.ev)
			if kind != tc.kind || text != tc.text || !linksCall {
				t.Errorf("callNotice() = (%q, %q, %v), want (%q, %q, true)", kind, text, linksCall, tc.kind, tc.text)
			}
		})
	}
}

func TestCallNoticeStaysQuietForEventsThatAreNotNews(t *testing.T) {
	cases := []events.CallLifecycle{
		{Type: events.TypeCallEnded, Status: "ENDED"},           // a meeting that took place
		{Type: events.TypeCallEnded},                            // no status: an older producer
		{Type: events.TypeCallStarted, Status: "ENDED"},         // a stale or reordered start
		{Type: events.TypeCallStarted},                          // no status
		{Type: events.TypeCallParticipantAdded, Status: "LIVE"}, // a roster refresh, not an invitation
	}
	for _, ev := range cases {
		if kind, _, _ := callNotice(ev); kind != "" {
			t.Errorf("%s status=%q produced a %s notification", ev.Type, ev.Status, kind)
		}
	}
}

func TestCallNotificationNeverNotifiesTheActorOrDeadLettersAnOrdinaryEnd(t *testing.T) {
	c := newTestConsumer()
	actor := uuid.NewString()
	// Only the person who did it is on the list: nothing to create, so no database is touched.
	for _, ev := range []events.CallLifecycle{
		{Type: events.TypeCallStarted, Status: "LIVE", ActorID: actor, Members: []string{actor}},
		{Type: events.TypeCallEnded, Status: "CANCELLED", ActorID: actor, Members: []string{actor}},
		{Type: events.TypeCallScheduled, Change: "updated", ActorID: actor, Members: []string{actor}},
	} {
		ev.EventID, ev.OrgID, ev.CallID, ev.Kind = uuid.NewString(), uuid.NewString(), uuid.NewString(), "MEETING"
		value, _ := json.Marshal(ev)
		if err := c.callNotification(context.Background(), nil, value); err != nil {
			t.Errorf("%s: callNotification() = %v, want nil", ev.Type, err)
		}
	}
	// An ordinary end with none of the fields a notification needs is ignored, not dead-lettered.
	value, _ := json.Marshal(events.CallLifecycle{Type: events.TypeCallEnded, Status: "ENDED"})
	if err := c.callNotification(context.Background(), nil, value); err != nil {
		t.Errorf("ordinary call.ended = %v, want nil", err)
	}
}
