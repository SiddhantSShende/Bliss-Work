package store

import "testing"

// A host walking out ends the meeting. That is the whole of bug "the meeting
// stays LIVE after the organiser leaves", and it is one predicate, so this
// tests the predicate rather than the transaction around it.
//
// The cases that must NOT end a call matter more than the one that must: every
// false negative here leaves a room nobody is hosting, and every false positive
// takes a working meeting away from the people still in it.
func TestEndsCallOnLeave(t *testing.T) {
	const (
		hostOrg = "org-host"
		other   = "org-other"
	)
	call := func(org, status string) *callRow {
		return &callRow{id: "call-1", orgID: org, kind: CallMeeting, status: status}
	}

	cases := []struct {
		name      string
		callerOrg string
		seat      callerSeat
		call      *callRow
		want      bool
	}{
		{
			name:      "the host leaving a live call ends it",
			callerOrg: hostOrg,
			seat:      callerSeat{role: RoleHost},
			call:      call(hostOrg, CallLive),
			want:      true,
		}, {
			// The organiser giving up on a call that never started takes it with
			// them: everyone else is sitting in its lobby waiting for exactly the
			// person who just walked away.
			name:      "the host leaving before it starts ends it",
			callerOrg: hostOrg,
			seat:      callerSeat{role: RoleHost, waiting: true},
			call:      call(hostOrg, CallScheduled),
			want:      true,
		}, {
			name:      "a participant leaving leaves the call running",
			callerOrg: hostOrg,
			seat:      callerSeat{role: RoleParticipant},
			call:      call(hostOrg, CallLive),
			want:      false,
		}, {
			// An org admin or channel owner CAN end a call — with the End
			// control, deliberately. Dropping in on someone else's meeting and
			// then leaving is not that decision.
			name:      "someone not on the roster leaving leaves the call running",
			callerOrg: hostOrg,
			seat:      callerSeat{},
			call:      call(hostOrg, CallLive),
			want:      false,
		}, {
			name:      "a host from another org cannot end the hosting org's call",
			callerOrg: other,
			seat:      callerSeat{role: RoleHost},
			call:      call(hostOrg, CallLive),
			want:      false,
		}, {
			name:      "leaving a call that already ended ends nothing",
			callerOrg: hostOrg,
			seat:      callerSeat{role: RoleHost},
			call:      call(hostOrg, CallEnded),
			want:      false,
		}, {
			name:      "leaving a cancelled call ends nothing",
			callerOrg: hostOrg,
			seat:      callerSeat{role: RoleHost},
			call:      call(hostOrg, CallCancelled),
			want:      false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := endsCallOnLeave(tc.callerOrg, tc.seat, tc.call); got != tc.want {
				t.Errorf("endsCallOnLeave = %v, want %v", got, tc.want)
			}
		})
	}
}
