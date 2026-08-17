package store

import (
	"context"
	"testing"
)

// canStartCallTx decides who may open a scheduled call, and the waiting-room
// poll asks it every few seconds for every person sitting in a lobby.
//
// A NIL transaction is passed on purpose. Three of the four routes through this
// function reach a verdict from values the caller already has, and passing nil
// is what proves it: a path that reached for the database would panic rather
// than quietly costing a round trip per poll. The fourth route — a channel
// owner or admin who is not otherwise entitled — genuinely needs a query, and
// is covered by the integration suite instead.
func TestCanStartCallNeedsNoQueryForTheCommonVerdicts(t *testing.T) {
	const (
		hostOrg = "org-host"
		other   = "org-other"
		channel = "ch-1"
	)
	channelCall := func(org string) *callRow {
		ch := channel
		return &callRow{id: "call-1", orgID: org, kind: CallChannel, channelID: &ch}
	}
	meeting := func(org string) *callRow {
		return &callRow{id: "call-1", orgID: org, kind: CallMeeting}
	}

	cases := []struct {
		name       string
		callerOrg  string
		role       string
		claimRoles []string
		call       *callRow
		want       bool
	}{
		{
			name:      "the host may start their own call",
			callerOrg: hostOrg,
			role:      RoleHost,
			call:      meeting(hostOrg),
			want:      true,
		}, {
			// The host check comes first deliberately: a guest host in someone
			// else's meeting is still its host.
			name:      "a host from another org may still start it",
			callerOrg: other,
			role:      RoleHost,
			call:      meeting(hostOrg),
			want:      true,
		}, {
			name:       "an org admin may start a call belonging to their org",
			callerOrg:  hostOrg,
			role:       RoleParticipant,
			claimRoles: []string{"org_admin"},
			call:       meeting(hostOrg),
			want:       true,
		}, {
			// THE QUALIFIER THAT MATTERS. Admin over your own workspace is not
			// admin over the workspace that invited you to a meeting.
			name:       "an org admin may not start another org's call",
			callerOrg:  other,
			role:       RoleParticipant,
			claimRoles: []string{"org_admin"},
			call:       meeting(hostOrg),
			want:       false,
		}, {
			name:       "an org admin of another org may not start its channel call",
			callerOrg:  other,
			role:       "",
			claimRoles: []string{"org_admin"},
			call:       channelCall(hostOrg),
			want:       false,
		}, {
			// Arriving first confers nothing.
			name:      "a plain participant may not start a meeting",
			callerOrg: hostOrg,
			role:      RoleParticipant,
			call:      meeting(hostOrg),
			want:      false,
		}, {
			name:      "someone not on the roster may not start a meeting",
			callerOrg: hostOrg,
			role:      "",
			call:      meeting(hostOrg),
			want:      false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := canStartCallTx(
				context.Background(), nil, tc.callerOrg, "u-1", tc.role, tc.claimRoles, tc.call)
			if err != nil {
				t.Fatalf("canStartCallTx: %v", err)
			}
			if got != tc.want {
				t.Errorf("canStartCallTx = %v, want %v", got, tc.want)
			}
		})
	}
}

// A DIRECT call has no channel to inherit permissions from, so the channel
// route must not be attempted for one — with a nil tx, attempting it panics.
func TestCanStartDirectCallTakesNoChannelRoute(t *testing.T) {
	c := &callRow{id: "call-1", orgID: "org-1", kind: CallDirect}
	got, err := canStartCallTx(context.Background(), nil, "org-1", "u-1", RoleParticipant, nil, c)
	if err != nil {
		t.Fatalf("canStartCallTx: %v", err)
	}
	if got {
		t.Error("a participant in a direct call was allowed to start it")
	}
}

// A CHANNEL call whose channel_id is somehow absent must not be treated as a
// channel call. The nil tx makes the consequence of getting this wrong loud: a
// nil-pointer dereference on channelID, or a query against a nil transaction.
func TestCanStartChannelCallWithNoChannelIDIsRefusedNotDereferenced(t *testing.T) {
	c := &callRow{id: "call-1", orgID: "org-1", kind: CallChannel, channelID: nil}
	got, err := canStartCallTx(context.Background(), nil, "org-1", "u-1", RoleParticipant, nil, c)
	if err != nil {
		t.Fatalf("canStartCallTx: %v", err)
	}
	if got {
		t.Error("a channel call with no channel was startable by a plain participant")
	}
}
