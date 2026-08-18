package server

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Presence must be registered per MEMBERSHIP, never per socket-org.
//
// A source-level check, and the reason is worth stating rather than apologising
// for: the connect path takes a *store.Store (a concrete type on a live Redis),
// so there is no seam to inject a fake through, and building one to observe
// three `for` loops would be a larger change than the thing it tests. The
// behaviour those loops produce IS covered — against a real Redis — by
// TestIntegrationOneSocketPutsThePersonOnlineInEveryOrg and its siblings in
// internal/store.
//
// What is left uncovered by that split is precisely this: that conn.go still
// FEEDS those store calls every membership rather than only claims.OrgID /
// claims.UserID. Reverting to the single-org form is a one-word edit, it
// compiles, every other test stays green, and the symptom is a person showing
// offline to colleagues in the orgs they are not currently looking at — which
// nobody notices until someone complains. So it is asserted here, in the same
// spirit as internal/store's arithmetic guards.
func TestPresenceIsRegisteredForEveryMembership(t *testing.T) {
	src, err := os.ReadFile("conn.go")
	if err != nil {
		t.Fatalf("read conn.go: %v", err)
	}
	body := string(src)

	// The four store calls that carry presence, and the argument each must be
	// given. `m` is the loop variable over claims.Memberships.
	calls := []struct {
		call string
		want string
		why  string
	}{
		{"s.store.AddPresence(", "m.UserID",
			"a connecting person is recorded under only one of their membership ids"},
		{"s.store.AddOrgPresence(", "m.OrgID, m.UserID",
			"only the signed-in org learns the person came online"},
		{"s.store.RemovePresence(", "m.UserID",
			"disconnecting leaves presence behind in the other orgs"},
		{"s.store.RemoveOrgPresenceIfLast(", "m.OrgID, m.UserID",
			"the other orgs keep showing the person online after they leave"},
		{"s.store.TouchPresence(", "m.OrgID, m.UserID",
			"orgs the person is not looking at age out of the stale window"},
	}

	for _, c := range calls {
		idx := strings.Index(body, c.call)
		if idx < 0 {
			t.Errorf("%s is gone from conn.go; if it moved, update this test rather "+
				"than deleting the case", c.call)
			continue
		}
		args := body[idx+len(c.call):]
		if end := strings.Index(args, ")"); end >= 0 {
			args = args[:end]
		}
		if !strings.Contains(args, c.want) {
			t.Errorf("%s no longer takes %s — %s\n  got: %s(%s)",
				c.call, c.want, c.why, c.call, strings.TrimSpace(args))
		}
	}

	// And the loop itself: the calls above are meaningless if nothing iterates.
	loop := regexp.MustCompile(`for\s+_,\s*m\s*:=\s*range\s+claims\.Memberships`)
	if n := len(loop.FindAllString(body, -1)); n < 2 {
		t.Errorf("found %d `range claims.Memberships` loops in conn.go, want at "+
			"least 2 (connect and disconnect)", n)
	}
	if !strings.Contains(body, "s.writeLoop(ctx, cancel, ws, conn, claims.Memberships)") {
		t.Error("writeLoop is no longer given the membership list, so the presence " +
			"heartbeat can only cover one org")
	}
}
