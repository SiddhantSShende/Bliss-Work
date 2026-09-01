package sweep

import (
	"testing"
	"time"
)

// The watchdog's whole job is to repair a lost notification without becoming a
// source of noise itself. Every case here is one of those two halves.

var base = time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

func pin(assignee string, openedMinutesAgo, attempts int) Pin {
	return Pin{
		TaskID:           "task-" + assignee,
		OrgID:            "org-1",
		AssigneeID:       assignee,
		OpenedAt:         base.Add(-time.Duration(openedMinutesAgo) * time.Minute),
		DeliveryAttempts: attempts,
	}
}

func TestPlan(t *testing.T) {
	cases := []struct {
		name  string
		pins  []Pin
		want  []Refresh
		about string
	}{
		{
			name:  "a pin past its first backoff is nudged",
			pins:  []Pin{pin("alice", 2, 0)},
			want:  []Refresh{{OrgID: "org-1", AssigneeID: "alice", PinCount: 1}},
			about: "the repair half: an assignment nobody has confirmed seeing",
		},
		{
			name:  "a pin still inside its backoff is left alone",
			pins:  []Pin{pin("alice", 0, 0)},
			want:  nil,
			about: "a note that was assigned seconds ago has not been lost yet",
		},
		{
			name: "many pins for one person produce ONE nudge",
			pins: []Pin{
				pin("alice", 30, 0),
				{TaskID: "t2", OrgID: "org-1", AssigneeID: "alice", OpenedAt: base.Add(-30 * time.Minute)},
				{TaskID: "t3", OrgID: "org-1", AssigneeID: "alice", OpenedAt: base.Add(-30 * time.Minute)},
			},
			want:  []Refresh{{OrgID: "org-1", AssigneeID: "alice", PinCount: 3}},
			about: "someone handed six tasks while offline needs one 'go and look'",
		},
		{
			name:  "different people each get their own nudge",
			pins:  []Pin{pin("alice", 30, 0), pin("bob", 30, 0)},
			want: []Refresh{
				{OrgID: "org-1", AssigneeID: "alice", PinCount: 1},
				{OrgID: "org-1", AssigneeID: "bob", PinCount: 1},
			},
			about: "grouping is per person, not global",
		},
		{
			name: "the same user id in two orgs is two recipients",
			pins: []Pin{
				pin("alice", 30, 0),
				{TaskID: "t2", OrgID: "org-2", AssigneeID: "alice", OpenedAt: base.Add(-30 * time.Minute)},
			},
			want: []Refresh{
				{OrgID: "org-1", AssigneeID: "alice", PinCount: 1},
				{OrgID: "org-2", AssigneeID: "alice", PinCount: 1},
			},
			about: "delivery is scoped by org, so the grouping key must be too",
		},
		{
			name:  "a pin that has been nudged to the cap is given up on",
			pins:  []Pin{pin("alice", 10_000, MaxNudges)},
			want:  nil,
			about: "past the cap nobody is running a client; the poll is the net",
		},
		{
			name:  "no pins means no events at all",
			pins:  nil,
			want:  nil,
			about: "explicitly NOT a pinCount:0 'clear your desktop' broadcast",
		},
		{
			name:  "a pin with no assignee is skipped rather than nudging nobody",
			pins:  []Pin{{TaskID: "t", OrgID: "org-1", OpenedAt: base.Add(-time.Hour)}},
			want:  nil,
			about: "malformed input must not produce an undeliverable event",
		},
		{
			name: "one due pin nudges the person, and the count includes the rest",
			pins: []Pin{
				pin("alice", 30, 0),
				{TaskID: "t2", OrgID: "org-1", AssigneeID: "alice", OpenedAt: base, DeliveryAttempts: 0},
			},
			want:  []Refresh{{OrgID: "org-1", AssigneeID: "alice", PinCount: 2}},
			about: "the client re-fetches everything, so reporting less understates it",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Plan(tc.pins, base)
			if len(got) != len(tc.want) {
				t.Fatalf("%s\ngot %d refreshes, want %d: %+v", tc.about, len(got), len(tc.want), got)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("%s\nrefresh %d: got %+v, want %+v", tc.about, i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestBackoffLadderGrows(t *testing.T) {
	// A client that cannot be reached must not be retried at a constant rate
	// for as long as it stays unreachable.
	for i := 1; i < len(BackoffLadder); i++ {
		if BackoffLadder[i] <= BackoffLadder[i-1] {
			t.Fatalf("ladder must increase: [%d]=%v is not after [%d]=%v",
				i, BackoffLadder[i], i-1, BackoffLadder[i-1])
		}
	}
}

func TestBackoffIsHonoured(t *testing.T) {
	cases := []struct {
		attempts int
		openedAt time.Duration // ago
		wantDue  bool
	}{
		{attempts: 0, openedAt: 30 * time.Second, wantDue: false},
		{attempts: 0, openedAt: 2 * time.Minute, wantDue: true},
		{attempts: 1, openedAt: 2 * time.Minute, wantDue: false},
		{attempts: 1, openedAt: 6 * time.Minute, wantDue: true},
		{attempts: 3, openedAt: 30 * time.Minute, wantDue: false},
		{attempts: 3, openedAt: 2 * time.Hour, wantDue: true},
		// Past the ladder the last rung repeats rather than going unbounded.
		{attempts: 9, openedAt: 2 * time.Hour, wantDue: true},
	}
	for _, tc := range cases {
		p := Pin{
			TaskID:           "t",
			OrgID:            "org-1",
			AssigneeID:       "alice",
			OpenedAt:         base.Add(-tc.openedAt),
			DeliveryAttempts: tc.attempts,
		}
		got := len(Plan([]Pin{p}, base)) == 1
		if got != tc.wantDue {
			t.Errorf("attempts=%d openedAt=-%v: due=%v, want %v",
				tc.attempts, tc.openedAt, got, tc.wantDue)
		}
	}
}
