package push

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/task-board/ws-gateway/internal/metrics"
)

// ── Fakes ────────────────────────────────────────────────────────────────────

type fakeNodeStore struct {
	mu     sync.Mutex
	nodes  map[string][]string // userID -> nodeIDs
	addrs  map[string]string   // nodeID  -> base URL
	err    error
	forgot []string // node ids whose cached address was invalidated
}

func (f *fakeNodeStore) ForgetNodeAddr(nodeID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgot = append(f.forgot, nodeID)
}

func (f *fakeNodeStore) NodesForUsers(_ context.Context, ids []string) (map[string][]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[string][]string{}
	for _, u := range ids {
		if n, ok := f.nodes[u]; ok {
			out[u] = n
		}
	}
	return out, nil
}

func (f *fakeNodeStore) NodeAddrs(_ context.Context, ids []string) (map[string]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[string]string{}
	for _, n := range ids {
		if a, ok := f.addrs[n]; ok {
			out[n] = a
		}
	}
	return out, nil
}

type fakeLocal struct {
	mu    sync.Mutex
	here  map[string]bool // users with a socket on this node
	given []string        // users handed to local delivery, in order
}

func (f *fakeLocal) Fanout(userID string, _ []byte) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.given = append(f.given, userID)
	return f.here[userID]
}

// recorder is a stand-in gateway node: it records what was pushed to it.
type recorder struct {
	mu       sync.Mutex
	requests int
	users    []string
	payloads []string
}

func newNode(t *testing.T, r *recorder) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var b Batch
		body, _ := io.ReadAll(req.Body)
		if err := json.Unmarshal(body, &b); err != nil {
			t.Errorf("node could not decode the batch: %v", err)
		}
		r.mu.Lock()
		r.requests++
		for _, d := range b.Deliveries {
			r.users = append(r.users, d.UserID)
			r.payloads = append(r.payloads, string(d.Payload))
		}
		if b.Broadcast != nil {
			r.users = append(r.users, b.Broadcast.UserIDs...)
			r.payloads = append(r.payloads, string(b.Broadcast.Payload))
		}
		r.mu.Unlock()
		_ = json.NewEncoder(w).Encode(Result{})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// ── Tests ────────────────────────────────────────────────────────────────────

// The whole point of the change. A frame addressed to one user must reach the
// ONE node that holds them, and no other node may hear about it — the pub/sub
// this replaced delivered every frame to every node in the fleet.
func TestDeliverReachesOnlyTheNodesHoldingTheRecipients(t *testing.T) {
	var onA, onB, onC recorder
	nodeA, nodeB, nodeC := newNode(t, &onA), newNode(t, &onB), newNode(t, &onC)

	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}, "u2": {"B"}},
		addrs: map[string]string{"A": nodeA.URL, "B": nodeB.URL, "C": nodeC.URL},
	}
	local := &fakeLocal{here: map[string]bool{}}
	f := NewFanout(st, local, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{"type":"rtc.offer"}`))

	if onA.requests != 1 {
		t.Errorf("node A got %d requests, want 1", onA.requests)
	}
	if onB.requests != 0 || onC.requests != 0 {
		t.Errorf("nodes holding no recipient were contacted: B=%d C=%d — that is the "+
			"broadcast behaviour this replaces", onB.requests, onC.requests)
	}
}

// A user on two devices is held by two nodes, and both must be told.
func TestDeliverReachesEveryNodeHoldingTheUser(t *testing.T) {
	var onA, onB recorder
	nodeA, nodeB := newNode(t, &onA), newNode(t, &onB)
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A", "B"}},
		addrs: map[string]string{"A": nodeA.URL, "B": nodeB.URL},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{}`))

	if onA.requests != 1 || onB.requests != 1 {
		t.Errorf("A=%d B=%d, want one push each — a laptop and a phone are two nodes",
			onA.requests, onB.requests)
	}
}

// Local sockets are served in-process AND must not also be pushed to, or the
// user receives every frame twice.
func TestLocalSocketsAreServedOnceAndNotPushed(t *testing.T) {
	var onSelf recorder
	selfNode := newNode(t, &onSelf)
	st := &fakeNodeStore{
		// The registry legitimately lists this node for the user — that is how
		// presence records it — so the exclusion has to be explicit.
		nodes: map[string][]string{"u1": {"self"}},
		addrs: map[string]string{"self": selfNode.URL},
	}
	local := &fakeLocal{here: map[string]bool{"u1": true}}
	f := NewFanout(st, local, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{}`))

	if len(local.given) != 1 || local.given[0] != "u1" {
		t.Errorf("local delivery got %v, want [u1] exactly once", local.given)
	}
	if onSelf.requests != 0 {
		t.Error("pushed to our own node over HTTP; the recipient would get it twice")
	}
}

// A user connected here AND elsewhere gets the local copy in-process and the
// remote one by push — neither may be skipped.
func TestUserOnThisNodeAndAnotherGetsBoth(t *testing.T) {
	var onB recorder
	nodeB := newNode(t, &onB)
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"self", "B"}},
		addrs: map[string]string{"B": nodeB.URL},
	}
	local := &fakeLocal{here: map[string]bool{"u1": true}}
	f := NewFanout(st, local, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{}`))

	if len(local.given) != 1 {
		t.Errorf("local deliveries = %v, want one", local.given)
	}
	if onB.requests != 1 {
		t.Errorf("node B got %d requests, want 1 — the other device must not be skipped",
			onB.requests)
	}
}

// Many recipients on one node must arrive as ONE request carrying the shared
// payload, not one request per recipient and not N copies of the payload. This
// is the presence shape: an org-wide transition to everyone on a given node.
func TestManyRecipientsOnOneNodeShareASingleRequestAndPayload(t *testing.T) {
	var onA recorder
	nodeA := newNode(t, &onA)
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}, "u2": {"A"}, "u3": {"A"}},
		addrs: map[string]string{"A": nodeA.URL},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1", "u2", "u3"}, []byte(`{"type":"presence.online"}`))

	if onA.requests != 1 {
		t.Errorf("made %d requests to one node, want 1", onA.requests)
	}
	got := append([]string(nil), onA.users...)
	sort.Strings(got)
	if len(got) != 3 || got[0] != "u1" || got[2] != "u3" {
		t.Errorf("node A received %v, want all three recipients", got)
	}
	if len(onA.payloads) != 1 {
		t.Errorf("payload was repeated %d times; the broadcast shape exists so one "+
			"event is not copied per recipient", len(onA.payloads))
	}
}

// Offline recipients are simply absent from the routing table. Not an error.
func TestOfflineRecipientsAreSkippedQuietly(t *testing.T) {
	var onA recorder
	nodeA := newNode(t, &onA)
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}}, // u2 is offline
		addrs: map[string]string{"A": nodeA.URL},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1", "u2"}, []byte(`{}`))

	if onA.requests != 1 || len(onA.users) != 1 || onA.users[0] != "u1" {
		t.Errorf("node A got %d requests for %v, want one for [u1]", onA.requests, onA.users)
	}
}

// A node whose registration expired between the presence read and the address
// lookup is skipped; the live nodes must still be served.
func TestNodeWithNoAddressIsSkippedWithoutLosingOthers(t *testing.T) {
	var onB recorder
	nodeB := newNode(t, &onB)
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"gone"}, "u2": {"B"}},
		addrs: map[string]string{"B": nodeB.URL}, // "gone" has expired
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1", "u2"}, []byte(`{}`))

	if onB.requests != 1 {
		t.Errorf("node B got %d requests, want 1 — a dead peer must not stop the rest",
			onB.requests)
	}
}

// Addresses are cached, so a push that fails must invalidate the entry rather
// than letting every delivery for the rest of the TTL retry a pod that has gone.
func TestAFailedPushInvalidatesTheCachedAddress(t *testing.T) {
	// A listener that is closed immediately: the address is syntactically fine
	// and nothing is behind it, which is exactly a pod that has been replaced.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := dead.URL
	dead.Close()

	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}},
		addrs: map[string]string{"A": addr},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{}`))

	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.forgot) != 1 || st.forgot[0] != "A" {
		t.Errorf("invalidated %v, want [A] — a failed push must not leave the address cached",
			st.forgot)
	}
}

// A push that SUCCEEDS must leave the cache alone, or the cache never holds
// anything and the round trip it was added to remove comes straight back.
func TestASuccessfulPushKeepsTheCachedAddress(t *testing.T) {
	nodeA := newNode(t, &recorder{})
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}},
		addrs: map[string]string{"A": nodeA.URL},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{}`))

	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.forgot) != 0 {
		t.Errorf("invalidated %v after a successful push", st.forgot)
	}
}

// A Redis failure must not panic or block; signalling and presence are
// best-effort and the caller has nothing useful to do with the error.
func TestRoutingFailureIsSurvivable(t *testing.T) {
	st := &fakeNodeStore{err: errStub{}}
	local := &fakeLocal{here: map[string]bool{"u1": true}}
	f := NewFanout(st, local, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), []string{"u1"}, []byte(`{}`))

	// The local socket still got it — the lookup only governs remote delivery.
	if len(local.given) != 1 {
		t.Error("a routing-table failure also suppressed local delivery")
	}
}

func TestDeliverIgnoresEmptyInput(t *testing.T) {
	var onA recorder
	nodeA := newNode(t, &onA)
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}},
		addrs: map[string]string{"A": nodeA.URL},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	f.Deliver(context.Background(), nil, []byte(`{}`))
	f.Deliver(context.Background(), []string{"u1"}, nil)

	if onA.requests != 0 {
		t.Errorf("made %d requests for an empty delivery", onA.requests)
	}
}

// ── Unroutable accounting ────────────────────────────────────────────────────
//
// WSGatewayCrossNodeDeliveryUnroutable is the only thing that reports a fleet
// where WS_ADVERTISE_ADDR is unset, and it keys entirely on this counter. If the
// counter is wrong the alert is wrong, and the failure it exists to catch is
// silent by construction — so the arithmetic is worth pinning down.

func unroutableCount(t *testing.T) float64 {
	t.Helper()
	return testutil.ToFloat64(metrics.NodeFanoutUnroutableTotal)
}

func TestUnroutableCountsUsersReachableNowhere(t *testing.T) {
	nodeA := newNode(t, &recorder{})
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A"}}, // u2 and u3 are nowhere
		addrs: map[string]string{"A": nodeA.URL},
	}
	local := &fakeLocal{here: map[string]bool{"u4": true}}
	f := NewFanout(st, local, NewHTTPTransport(NewClient("t"), st), "self", discard())

	before := unroutableCount(t)
	f.Deliver(context.Background(), []string{"u1", "u2", "u3", "u4"}, []byte(`{}`))

	if got := unroutableCount(t) - before; got != 2 {
		t.Errorf("counted %v unroutable, want 2 — u1 routes remotely and u4 is local, "+
			"so only u2 and u3 are reachable nowhere", got)
	}
}

// A user with sockets on two peers is ONE reachable recipient. Counting node
// hops instead of users would let a two-device user cancel out a genuinely
// unroutable one, and the ratio the alert reads would understate the problem.
func TestUnroutableIsNotCancelledOutByMultiDeviceUsers(t *testing.T) {
	nodeA, nodeB := newNode(t, &recorder{}), newNode(t, &recorder{})
	st := &fakeNodeStore{
		nodes: map[string][]string{"u1": {"A", "B"}}, // one user, two nodes
		addrs: map[string]string{"A": nodeA.URL, "B": nodeB.URL},
	}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	before := unroutableCount(t)
	f.Deliver(context.Background(), []string{"u1", "u2"}, []byte(`{}`))

	if got := unroutableCount(t) - before; got != 1 {
		t.Errorf("counted %v unroutable, want 1 — u1's two nodes are one recipient, "+
			"and u2 is reachable nowhere", got)
	}
}

// The everything-is-broken case the alert is named for: several pods, none of
// them registered, so nothing off this node can be reached.
func TestUnroutableCountsEveryoneWhenNoNodeIsRegistered(t *testing.T) {
	st := &fakeNodeStore{nodes: map[string][]string{}, addrs: map[string]string{}}
	f := NewFanout(st, &fakeLocal{here: map[string]bool{}}, NewHTTPTransport(NewClient("t"), st), "self", discard())

	before := unroutableCount(t)
	f.Deliver(context.Background(), []string{"u1", "u2", "u3"}, []byte(`{}`))

	if got := unroutableCount(t) - before; got != 3 {
		t.Errorf("counted %v unroutable, want 3 — an unregistered fleet can reach nobody", got)
	}
}

type errStub struct{}

func (errStub) Error() string { return "stub" }
