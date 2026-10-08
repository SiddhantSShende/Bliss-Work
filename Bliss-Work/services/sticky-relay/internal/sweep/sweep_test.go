package sweep

import (
	"testing"
	"time"
)

func pin(org, who string, attempts int) Pin {
	return Pin{TaskID: "t", OrgID: org, AssigneeID: who, OpenedAt: time.Unix(0, 0), DeliveryAttempts: attempts}
}

// B-SR-1: sticky-svc reports the POST-claim attempt count and claims while the
// pre-claim count is below MaxNudges, so the last claim it makes comes back as
// exactly MaxNudges. That nudge is allowed and must be sent.
func TestPlanSendsTheLastAllowedNudge(t *testing.T) {
	got := Plan([]Pin{pin("o", "a", MaxNudges)})
	if len(got) != 1 || got[0].AssigneeID != "a" {
		t.Fatalf("Plan with attempts == MaxNudges = %+v, want one refresh", got)
	}
}

func TestPlanDropsPinsPastTheCap(t *testing.T) {
	if got := Plan([]Pin{pin("o", "a", MaxNudges+1)}); len(got) != 0 {
		t.Fatalf("Plan past MaxNudges = %+v, want none", got)
	}
}

func TestPlanGroupsPerPersonAndScopesByOrg(t *testing.T) {
	got := Plan([]Pin{pin("o1", "a", 1), pin("o1", "a", 2), pin("o2", "a", 1)})
	if len(got) != 2 {
		t.Fatalf("got %+v, want one refresh per (org, person)", got)
	}
	if got[0].OrgID != "o1" || got[0].PinCount != 2 || got[1].OrgID != "o2" || got[1].PinCount != 1 {
		t.Fatalf("unexpected grouping: %+v", got)
	}
}
