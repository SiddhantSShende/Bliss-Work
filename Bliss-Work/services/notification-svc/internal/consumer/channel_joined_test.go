package consumer

import (
	"testing"

	"github.com/task-board/notification-svc/internal/events"
)

const (
	joinedEventID = "22222222-2222-2222-2222-222222222222"
	addedUser     = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	otherUser     = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
)

// TestChannelMemberJoined_OnlyNotifiesWhenSomeoneElseAddedYou is the whole point
// of the event carrying an actor at all.
//
// messaging-svc emits channel.member.joined for BOTH ways a membership starts:
// an existing member adding you (which you have no other way of finding out
// about — the channel just appears) and your own click on Join for an open
// channel (which you obviously know about). Notifying on the second is noise,
// and telling someone "you were added to #general" about a channel they joined
// themselves is worse than noise: it is wrong.
//
// reachedDB stands in for "this event produced a notification" — see callHandle.
func TestChannelMemberJoined_OnlyNotifiesWhenSomeoneElseAddedYou(t *testing.T) {
	c := newTestConsumer()

	cases := []struct {
		name       string
		userID     string
		actorID    string
		wantNotify bool
	}{
		{"added by someone else", addedUser, otherUser, true},
		{"self-join of an open channel", addedUser, addedUser, false},
		{"absent actor (producer predates the field)", addedUser, "", false},
		{"no user id at all", "", otherUser, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := mustMarshal(t, events.ChannelMemberJoined{
				Type:        events.TypeChannelMemberJoined,
				EventID:     joinedEventID,
				OrgID:       "org-1",
				ChannelID:   "chan-1",
				ChannelName: "general",
				UserID:      tc.userID,
				ActorID:     tc.actorID,
			})

			err, reachedDB := callHandle(c, value)

			if reachedDB != tc.wantNotify {
				t.Fatalf("notified = %v, want %v", reachedDB, tc.wantNotify)
			}
			if !tc.wantNotify && err != nil {
				t.Fatalf("ignored join returned err %v, want nil", err)
			}
		})
	}
}

// A malformed channel event must dead-letter like any other, rather than
// wedging the partition it arrived on.
func TestChannelMemberJoined_MalformedIsDeadLettered(t *testing.T) {
	c := newTestConsumer()

	// Parses as the generic task-event envelope (so routing sees the type) but
	// not as ChannelMemberJoined, whose userId is a string.
	value := []byte(`{"type":"channel.member.joined","userId":{"nested":true}}`)

	err, reachedDB := callHandle(c, value)

	if reachedDB {
		t.Fatal("reached the DB on a malformed channel event")
	}
	if err == nil {
		t.Fatal("got nil, want errMalformed so the message dead-letters")
	}
}

func TestChannelAddedText(t *testing.T) {
	if got := channelAddedText("general"); got != "You were added to #general" {
		t.Errorf("got %q", got)
	}
	// A producer older than the channelName field still owes the user a
	// notification — just a vaguer one.
	if got := channelAddedText(""); got != "You were added to a channel" {
		t.Errorf("got %q", got)
	}
}
