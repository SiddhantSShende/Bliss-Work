package store

import (
	"strings"
	"testing"
)

// ── Key naming ───────────────────────────────────────────────────────────────

// A single-node deployment must see EXACTLY the key names it saw before this
// change. Braces are ordinary characters to a standalone Redis, so tagging
// unconditionally would have been harmless in behaviour and expensive in
// practice: it renames every key, and the replay outbox holds seven days of
// catch-up history that a rename silently discards for every user.
func TestSingleNodeKeysAreUnchanged(t *testing.T) {
	s := &Store{} // clustered == false
	cases := map[string]string{
		s.presenceKey("u1"):    "presence:u:u1",
		s.orgPresenceKey("o1"): "presence:o:o1",
		s.outboxKey("u1"):      "outbox:user:u1",
		s.nodeKey("n1"):        "node:n1",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("key = %q, want %q — renaming a key on a single node drops "+
				"whatever was stored under the old name", got, want)
		}
	}
}

// In cluster mode the id is wrapped so Redis hashes only that section, which is
// what puts a user's presence entry and their replay outbox on the SAME node —
// otherwise the two reads a delivery needs become two hops to two machines.
func TestClusterKeysAreHashTagged(t *testing.T) {
	s := &Store{clustered: true}
	cases := map[string]string{
		s.presenceKey("u1"):    "presence:u:{u1}",
		s.orgPresenceKey("o1"): "presence:o:{o1}",
		s.outboxKey("u1"):      "outbox:user:{u1}",
		s.nodeKey("n1"):        "node:{n1}",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("key = %q, want %q", got, want)
		}
	}
}

// The point of the tag is co-location, so the two keys a delivery touches for
// one user must carry the SAME tag. If they differed, the hash tag would be
// decoration rather than a routing decision.
func TestAUsersKeysShareOneHashTag(t *testing.T) {
	s := &Store{clustered: true}
	presence := s.presenceKey("user-42")
	outbox := s.outboxKey("user-42")

	tagOf := func(k string) string {
		open := strings.Index(k, "{")
		close := strings.Index(k, "}")
		if open < 0 || close < open {
			t.Fatalf("key %q carries no hash tag", k)
		}
		return k[open+1 : close]
	}
	if tagOf(presence) != tagOf(outbox) {
		t.Errorf("presence tag %q and outbox tag %q differ; the two would land on "+
			"different nodes and the tag would buy nothing",
			tagOf(presence), tagOf(outbox))
	}
}

// ── Client construction ──────────────────────────────────────────────────────

func TestSplitURLsAcceptsOneOrMany(t *testing.T) {
	cases := map[string][]string{
		"redis://a:6379":                          {"redis://a:6379"},
		"redis://a:6379,redis://b:6379":           {"redis://a:6379", "redis://b:6379"},
		" redis://a:6379 , redis://b:6379 ":       {"redis://a:6379", "redis://b:6379"},
		"redis://a:6379,,redis://b:6379":          {"redis://a:6379", "redis://b:6379"},
		"redis://a:6379,redis://b:6379,redis://c": {"redis://a:6379", "redis://b:6379", "redis://c"},
	}
	for in, want := range cases {
		got := splitURLs(in)
		if len(got) != len(want) {
			t.Errorf("splitURLs(%q) = %v, want %v", in, got, want)
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("splitURLs(%q)[%d] = %q, want %q", in, i, got[i], want[i])
			}
		}
	}
}

// One URL is the client this service has always used; several make it a cluster
// client. That single distinction is the whole switch, and it also decides the
// keyspace — so getting it wrong is not a performance question.
func TestOneURLIsSingleNodeAndSeveralIsACluster(t *testing.T) {
	single, err := New("redis://localhost:6379/0")
	if err != nil {
		t.Fatalf("New(single): %v", err)
	}
	defer func() { _ = single.Close() }()
	if single.Clustered() {
		t.Error("one URL produced a cluster client")
	}
	if got := single.presenceKey("u"); got != "presence:u:u" {
		t.Errorf("single-node key = %q, want the untagged name", got)
	}

	cluster, err := New("redis://a:6379,redis://b:6379,redis://c:6379")
	if err != nil {
		t.Fatalf("New(cluster): %v", err)
	}
	defer func() { _ = cluster.Close() }()
	if !cluster.Clustered() {
		t.Error("three URLs did not produce a cluster client")
	}
	if got := cluster.presenceKey("u"); got != "presence:u:{u}" {
		t.Errorf("cluster key = %q, want the tagged name", got)
	}
}

func TestNewRejectsAnEmptyURL(t *testing.T) {
	for _, in := range []string{"", "   ", ",", " , "} {
		if _, err := New(in); err == nil {
			t.Errorf("New(%q) succeeded; an empty address list must not produce a client", in)
		}
	}
}

// ── Heartbeat TTL sampling ───────────────────────────────────────────────────

// The TTL is re-armed on a fraction of beats rather than every one. What makes
// that safe is the margin: presenceTTL is far longer than the beat, so a key is
// refreshed many times over inside every expiry window.
//
// This asserts the invariant rather than the constant, so changing either the
// beat or the TTL cannot quietly leave a key expiring under a live socket.
func TestTTLRefreshStaysWellInsideTheExpiryWindow(t *testing.T) {
	refreshEvery := PresenceHeartbeatInterval * ttlRefreshEveryN
	if refreshEvery >= presenceTTL {
		t.Fatalf("TTL is re-armed every %v but keys expire after %v — a live "+
			"socket's presence key would vanish underneath it",
			refreshEvery, presenceTTL)
	}
	// Two full refresh cycles inside the window, so losing one to a Redis blip
	// is not enough to expire the key.
	if refreshEvery*2 >= presenceTTL {
		t.Errorf("only %v of margin between the TTL refresh cycle (%v) and expiry "+
			"(%v); one missed cycle should not be able to expire a live key",
			presenceTTL-refreshEvery, refreshEvery, presenceTTL)
	}
}

// The stale window must clear at least two beats, or an ordinary GC pause or a
// slow Redis round trip would mark a connected user offline.
func TestStaleWindowClearsTwoHeartbeats(t *testing.T) {
	if presenceStaleAfter < 2*PresenceHeartbeatInterval {
		t.Fatalf("stale window %v is under two %v heartbeats; a single missed beat "+
			"would flicker live users offline",
			presenceStaleAfter, PresenceHeartbeatInterval)
	}
}

// The first beat of a process always arms the TTL, so a freshly-started pod
// does not leave keys unarmed for several beats.
func TestFirstHeartbeatOfAProcessRefreshesTheTTL(t *testing.T) {
	ttlBeat.Store(0)
	if !shouldRefreshTTL() {
		t.Error("the first beat did not refresh the TTL")
	}
	// And then it samples rather than refreshing every time.
	refreshed := 0
	for i := 0; i < ttlRefreshEveryN*4; i++ {
		if shouldRefreshTTL() {
			refreshed++
		}
	}
	if refreshed != 4 {
		t.Errorf("refreshed %d times over %d beats, want 4 (1 in %d)",
			refreshed, ttlRefreshEveryN*4, ttlRefreshEveryN)
	}
}
