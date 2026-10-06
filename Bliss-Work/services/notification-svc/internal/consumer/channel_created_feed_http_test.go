package consumer

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/task-board/notification-svc/internal/events"
)

// Channel creation, from the event messaging-svc emits for its
// "<creator> created channel <name>" system message through the real consumer
// entry point (handle) to the real HTTP feed. Needs NOTIFICATION_TEST_DATABASE_URL.
//
// Pins: every member the channel was created with — the creator excepted — gets
// exactly one CHANNEL_CREATED row that says they were added to a new channel and
// carries the channel's id (the client opens /app/channels/<id> from it); the
// "were added to channel" message and a redelivery add nothing; and a member added
// LATER is still told by channel.member.joined, unchanged.

func TestChannelCreationNotifiesEveryAddedMemberExactlyOnce(t *testing.T) {
	env := newFeedEnv(t)
	ctx := context.Background()
	creator, amy, bob := uuid.NewString(), uuid.NewString(), uuid.NewString()
	channel := uuid.NewString()
	c := &Consumer{pool: env.pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	handle := func(ev any) {
		t.Helper()
		payload, _ := json.Marshal(ev)
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.handle(ctx, tx, payload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("handle: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	message := func(eventID, kind, body string) events.ChannelMessageCreated {
		return events.ChannelMessageCreated{
			Type: events.TypeChannelMessageCreated, EventID: eventID, OrgID: env.orgID,
			ChannelID: channel, MessageID: uuid.NewString(), SenderID: creator, SenderUsername: "jdoe",
			SenderDisplayName: "Jordan Doe", ChannelName: "project room", Body: body, Kind: kind,
			Members: []string{creator, amy, bob},
		}
	}

	created := message(uuid.NewString(), "channel_created", "Jordan Doe created channel project room")
	added := message(uuid.NewString(), "channel_member_added", "Amy Adams, Bob Brown were added to channel")
	handle(created)
	handle(added)
	// Kafka redelivery of both events, and of the creation event a third time.
	handle(created)
	handle(added)
	handle(created)

	wantText := "Jordan Doe added you to the new channel project room"
	for name, uid := range map[string]string{"amy": amy, "bob": bob} {
		rows := env.feed(t, env.sign(uid), "")
		if !slices.Equal(kindsOf(rows), []string{"CHANNEL_CREATED"}) {
			t.Fatalf("%s's feed = %v, want exactly one CHANNEL_CREATED", name, kindsOf(rows))
		}
		if r := rows[0]; r.Text != wantText || r.ChannelID == nil || *r.ChannelID != channel || r.Read {
			t.Errorf("%s's row = %+v, want unread %q linking channel %s", name, r, wantText, channel)
		}
		if got := env.badge(t, env.sign(uid)); got != 1 {
			t.Errorf("%s's badge = %d, want 1", name, got)
		}
	}
	if rows := env.feed(t, env.sign(creator), ""); len(rows) != 0 {
		t.Errorf("the creator's feed = %v, want empty (they made the channel)", kindsOf(rows))
	}

	// Someone added later is a different event with a different notification.
	late := uuid.NewString()
	handle(events.ChannelMemberJoined{Type: events.TypeChannelMemberJoined, EventID: uuid.NewString(), OrgID: env.orgID,
		ChannelID: channel, ChannelName: "project room", UserID: late, ActorID: creator, ActorDisplayName: "Jordan Doe"})
	rows := env.feed(t, env.sign(late), "")
	if !slices.Equal(kindsOf(rows), []string{"CHANNEL_ADDED"}) || rows[0].Text != "Jordan Doe added you to the channel project room" {
		t.Errorf("a later-added member's feed = %+v, want one unchanged CHANNEL_ADDED", rows)
	}
}

func TestChannelCreatedWithNoOneElseNotifiesNobody(t *testing.T) {
	env := newFeedEnv(t)
	ctx := context.Background()
	creator := uuid.NewString()
	c := &Consumer{pool: env.pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	payload, _ := json.Marshal(events.ChannelMessageCreated{
		Type: events.TypeChannelMessageCreated, EventID: uuid.NewString(), OrgID: env.orgID,
		ChannelID: uuid.NewString(), MessageID: uuid.NewString(), SenderID: creator, SenderDisplayName: "Jordan Doe",
		ChannelName: "solo", Body: "Jordan Doe created channel solo", Kind: "channel_created", Members: []string{creator},
	})
	tx, _ := env.pool.Begin(ctx)
	if err := c.handle(ctx, tx, payload); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if rows := env.feed(t, env.sign(creator), ""); len(rows) != 0 {
		t.Errorf("feed = %v, want empty", kindsOf(rows))
	}
}
