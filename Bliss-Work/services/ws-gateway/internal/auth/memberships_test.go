package auth

import "testing"

// The `memberships` claim decides which organizations a connected person is
// marked online in. Every failure mode here is silent — you get presence in too
// few orgs, or a ghost member in one — so the guarantees are worth pinning
// rather than inferring from the caller.

func claim(pairs ...[2]string) []interface{} {
	out := make([]interface{}, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, map[string]interface{}{"o": p[0], "u": p[1]})
	}
	return out
}

func has(ms []Membership, orgID, userID string) bool {
	for _, m := range ms {
		if m.OrgID == orgID && m.UserID == userID {
			return true
		}
	}
	return false
}

func TestEveryMembershipInTheClaimIsCarried(t *testing.T) {
	// The whole point: one socket, three organizations to appear online in.
	got := normalizeMemberships(
		claim([2]string{"org-a", "me-in-a"}, [2]string{"org-b", "me-in-b"}, [2]string{"org-c", "me-in-c"}),
		"org-a", "me-in-a",
	)
	if len(got) != 3 {
		t.Fatalf("got %d memberships, want 3: %+v", len(got), got)
	}
	for _, want := range [][2]string{{"org-a", "me-in-a"}, {"org-b", "me-in-b"}, {"org-c", "me-in-c"}} {
		if !has(got, want[0], want[1]) {
			t.Errorf("missing %s/%s — that org would show the person offline", want[0], want[1])
		}
	}
}

func TestAClaimlessTokenStillGetsItsOwnMembership(t *testing.T) {
	// Tokens minted before the claim existed stay valid for their full TTL. They
	// must keep working exactly as they did — single-org presence, not none.
	got := normalizeMemberships(nil, "org-a", "me-in-a")
	if len(got) != 1 || !has(got, "org-a", "me-in-a") {
		t.Fatalf("got %+v, want exactly the current membership", got)
	}
}

func TestTheCurrentMembershipIsAddedWhenTheClaimOmitsIt(t *testing.T) {
	// The claim is a snapshot from mint time; `sub` + `org_id` are first-hand and
	// verified. Presence for THIS session must never depend on the snapshot.
	got := normalizeMemberships(claim([2]string{"org-b", "me-in-b"}), "org-a", "me-in-a")
	if !has(got, "org-a", "me-in-a") {
		t.Error("the org this socket is actually signed in to is missing — " +
			"the connecting user would show offline to their own colleagues")
	}
	if !has(got, "org-b", "me-in-b") {
		t.Error("the claimed membership was dropped")
	}
}

func TestTheCurrentMembershipIsNotDuplicated(t *testing.T) {
	// The normal case: the claim already lists it. Writing presence twice for
	// one org is wasted Redis traffic on the hottest path in the gateway.
	got := normalizeMemberships(
		claim([2]string{"org-a", "me-in-a"}, [2]string{"org-b", "me-in-b"}),
		"org-a", "me-in-a",
	)
	if len(got) != 2 {
		t.Fatalf("got %d memberships, want 2 (no duplicate): %+v", len(got), got)
	}
}

func TestHalfFormedEntriesAreDroppedRatherThanRepaired(t *testing.T) {
	// An entry with an empty user id would add a blank member to an org's online
	// set, which surfaces as a ghost nobody can account for.
	got := normalizeMemberships(
		claim([2]string{"org-b", ""}, [2]string{"", "me-in-c"}, [2]string{"org-d", "me-in-d"}),
		"org-a", "me-in-a",
	)
	for _, m := range got {
		if m.OrgID == "" || m.UserID == "" {
			t.Errorf("half-formed membership survived: %+v", m)
		}
	}
	if !has(got, "org-d", "me-in-d") {
		t.Error("a well-formed entry was dropped alongside the broken ones")
	}
	if len(got) != 2 {
		t.Fatalf("got %+v, want org-d plus the current membership", got)
	}
}

func TestGarbageInTheClaimDoesNotCostThePersonTheirOwnPresence(t *testing.T) {
	// A claim of the wrong shape entirely (a string, say) must degrade to
	// single-org presence, not to none — this runs on every socket connect.
	for name, raw := range map[string]interface{}{
		"string":        "org-a",
		"number":        42,
		"array of junk": []interface{}{"x", 1, nil},
		"map not array": map[string]interface{}{"o": "org-b", "u": "me-in-b"},
	} {
		got := normalizeMemberships(raw, "org-a", "me-in-a")
		if !has(got, "org-a", "me-in-a") {
			t.Errorf("%s: current membership lost", name)
		}
	}
}
