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
	// Connect uses the claims this function was handed (nothing has changed
	// yet); disconnect and the writeLoop heartbeat deliberately read
	// sess.claims.Load() instead — the LATEST, possibly-renewed list — so a
	// membership added or removed by auth.renew since connect is still
	// reflected when the socket closes or next beats, not the stale one this
	// function started with.
	connectLoop := regexp.MustCompile(`for\s+_,\s*m\s*:=\s*range\s+claims\.Memberships`)
	if n := len(connectLoop.FindAllString(body, -1)); n < 1 {
		t.Errorf("found %d `range claims.Memberships` loops in conn.go, want at least 1 (connect)", n)
	}
	liveLoop := regexp.MustCompile(`for\s+_,\s*m\s*:=\s*range\s+sess\.claims\.Load\(\)\.Memberships`)
	if n := len(liveLoop.FindAllString(body, -1)); n < 2 {
		t.Errorf("found %d `range sess.claims.Load().Memberships` loops in conn.go, want at "+
			"least 2 (disconnect cleanup and the writeLoop heartbeat) — reverting either to the "+
			"frozen `claims.Memberships` this function was called with would silently undo "+
			"auth.renew's presence reconciliation on the very next beat or on disconnect", n)
	}
	if !strings.Contains(body, "s.writeLoop(ctx, cancel, ws, conn, sess)") {
		t.Error("writeLoop is no longer given sess, so its heartbeat can't see a membership " +
			"change made after the socket connected")
	}

	// auth.renew must reconcile presence, not just swap the claims pointer —
	// this is the actual bug TestPresenceIsRegisteredForEveryMembership's
	// sibling checks above cannot see: they cover connect/disconnect/heartbeat,
	// none of which fire the moment a token renews mid-connection.
	renewIdx := strings.Index(body, `case "auth.renew":`)
	if renewIdx < 0 {
		t.Fatal(`case "auth.renew": is gone from conn.go; if it moved, update this test rather than deleting the case`)
	}
	// Scoped to roughly the case body (next "case " or end of the enclosing
	// switch), so this does not accidentally match reconcilePresence's own
	// definition or an unrelated later case.
	renewBody := body[renewIdx:]
	if end := strings.Index(renewBody[len(`case "auth.renew":`):], "\n\tcase "); end >= 0 {
		renewBody = renewBody[:len(`case "auth.renew":`)+end]
	}
	if !strings.Contains(renewBody, "s.reconcilePresence(") {
		t.Error(`case "auth.renew" no longer calls reconcilePresence — a membership added or ` +
			"removed by a token refresh would update sess.claims but leave presence exactly as " +
			"it was: a removed org's member keeps showing online (and reachable for RTC " +
			"signaling) there for as long as the socket stays open")
	}

	// reconcilePresence itself must actually touch all four presence calls —
	// the same ones the connect/disconnect loops use — for both directions of
	// the delta (see the calls table above for why each argument matters).
	reconcileIdx := strings.Index(body, "func (s *Server) reconcilePresence(")
	if reconcileIdx < 0 {
		t.Fatal("reconcilePresence is gone from conn.go; if it moved, update this test rather than deleting the case")
	}
	reconcileBody := body[reconcileIdx:]
	for _, call := range []string{
		"s.store.AddPresence(", "s.store.AddOrgPresence(",
		"s.store.RemovePresence(", "s.store.RemoveOrgPresenceIfLast(",
	} {
		if !strings.Contains(reconcileBody, call) {
			t.Errorf("reconcilePresence no longer calls %s — a membership delta from auth.renew "+
				"would go (partly) unreconciled", call)
		}
	}
}
