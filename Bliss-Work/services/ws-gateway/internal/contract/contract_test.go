package contract

import "testing"

// This file guards the Go mirror of packages/shared/src/types/events.ts. The two
// must agree exactly: the gateway routes on THIS code, so a type that routes
// correctly in TypeScript but falls through to `default` here is silently never
// delivered — a class of bug that is invisible until a user reports a missing
// notification.

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

// call.participant_left used to route NOWHERE — the type did not exist at
// all, so an ordinary participant leaving a call that kept going told nobody
// anything, including the leaver's own other open sessions/devices.
//
// Unlike channel.member.joined above, this routes to whatever messaging-svc
// put in Members verbatim (dedupe(e.Members)), not a hand-picked field here:
// the producer (notifyParticipantLeft) already computes "the live roster plus
// the leaver" server-side, since by the time this fires the leaver's own
// call_participants row is already closed and a plain roster read would miss
// them — the one recipient this event exists to reach.
func TestRecipientsOfCallParticipantLeft(t *testing.T) {
	const leaver = "11111111-1111-1111-1111-111111111111"
	const remaining = "22222222-2222-2222-2222-222222222222"

	got := (&Event{
		Type:    "call.participant_left",
		Members: []string{remaining, leaver},
	}).RecipientsOf()

	if len(got) != 2 {
		t.Fatalf("RecipientsOf() = %v, want both %s and %s delivered", got, remaining, leaver)
	}
}

// sticky.refresh is the desktop-note delivery watchdog (services/sticky-relay)
// telling one person's clients to re-fetch their pins, for the case where a
// task.assigned frame was lost — a reconnect at the wrong moment, or the user
// offline past the replay window.
//
// The name deliberately sits OUTSIDE the "task." prefix, because it is emitted
// by a different service and is about delivery rather than about a task. That
// makes it exactly the kind of type that falls through to `default` here and is
// silently never delivered, which is what this test exists to stop.
func TestRecipientsOfStickyRefresh(t *testing.T) {
	const assignee = "11111111-1111-1111-1111-111111111111"
	const sender = "22222222-2222-2222-2222-222222222222"

	got := (&Event{
		Type:       "sticky.refresh",
		AssigneeID: assignee,
		// Populated to prove they are ignored: the event carries no task
		// content, so there is no second party who could want it. Routing it to
		// a sender would tell them nothing and leak that someone has not read
		// their allocation.
		SenderID: sender,
		Members:  []string{sender},
	}).RecipientsOf()

	if len(got) != 1 || got[0] != assignee {
		t.Fatalf("RecipientsOf() = %v, want exactly [%s]", got, assignee)
	}
}

// A type this binary has never heard of must route NOWHERE rather than
// defaulting to the roster. Pinned because sticky.refresh above added the first
// non-"task." event to that area of the switch, and a well-meaning prefix match
// added later would quietly start delivering anything named sticky.*.
func TestRecipientsOfUnknownStickyEventIsEmpty(t *testing.T) {
	for _, typ := range []string{"sticky.dismissed", "sticky.", "sticky.something.new"} {
		got := (&Event{
			Type:       typ,
			AssigneeID: "11111111-1111-1111-1111-111111111111",
			Members:    []string{"22222222-2222-2222-2222-222222222222"},
		}).RecipientsOf()
		if len(got) != 0 {
			t.Errorf("RecipientsOf(%q) = %v, want no recipients", typ, got)
		}
	}
}
