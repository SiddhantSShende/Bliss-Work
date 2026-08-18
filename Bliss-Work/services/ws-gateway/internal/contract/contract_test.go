package contract

import "testing"

// This file guards the Go mirror of packages/shared/src/types/events.ts. The two
// must agree exactly: the gateway routes on THIS code, so a type that routes
// correctly in TypeScript but falls through to `default` here is silently never
// delivered — a class of bug that is invisible until a user reports a missing
// notification.

func TestRecipientsOfIntegrationEvents(t *testing.T) {
	const me = "11111111-1111-1111-1111-111111111111"

	tests := []struct {
		name  string
		event Event
		want  []string
	}{
		{
			name:  "activity routes to the connection owner",
			event: Event{Type: "integration.activity.created", RecipientID: me},
			want:  []string{me},
		},
		{
			name:  "mention routes to the mentioned user",
			event: Event{Type: "integration.mention.created", RecipientID: me},
			want:  []string{me},
		},
		{
			// Guards against a typo'd discriminant silently black-holing events.
			name:  "unknown type routes nowhere",
			event: Event{Type: "integration.mention.creted", RecipientID: me},
			want:  nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.event.RecipientsOf()
			if len(got) != len(tc.want) {
				t.Fatalf("RecipientsOf() = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("RecipientsOf()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// A mention event carries no messageId, so acking it would ask messaging-svc to
// mark a message that does not exist as delivered.
func TestIntegrationEventsAreExemptFromDeliveryAck(t *testing.T) {
	for _, typ := range []string{"integration.activity.created", "integration.mention.created"} {
		if _, ok := NoDeliveryAckFor[typ]; !ok {
			t.Errorf("%s must be in NoDeliveryAckFor", typ)
		}
	}
}

// The gateway only consumes topics in FanoutTopics; a mention published to
// integration.events.v1 that the gateway does not consume never reaches a socket.
func TestIntegrationTopicIsConsumed(t *testing.T) {
	for _, topic := range FanoutTopics {
		if topic == "integration.events.v1" {
			return
		}
	}
	t.Fatal("integration.events.v1 missing from FanoutTopics")
}

// channel.member.joined used to route NOWHERE. It exists so task-svc can fan
// out channel tasks to a new member, and it fell through to `default` here — so
// the person who had just been added to a channel was the one participant told
// nothing. Their sidebar grew a channel with no explanation and no notification.
//
// It routes to the added user ALONE, and that is a cost decision worth pinning:
// messaging-svc emits one of these PER ADDED MEMBER, so routing it to the roster
// would cost added x roster pushes — adding a 500-person department to a
// 500-person channel would be 250,000.
func TestRecipientsOfChannelMemberJoined(t *testing.T) {
	const joiner = "11111111-1111-1111-1111-111111111111"
	const roster = "22222222-2222-2222-2222-222222222222"

	got := (&Event{
		Type:    "channel.member.joined",
		UserID:  joiner,
		Members: []string{roster, "33333333-3333-3333-3333-333333333333"},
	}).RecipientsOf()

	if len(got) != 1 || got[0] != joiner {
		t.Fatalf("RecipientsOf() = %v, want exactly [%s] — the roster must NOT be fanned out to", got, joiner)
	}
}
