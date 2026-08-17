package router

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sort"
	"sync"
	"testing"

	"github.com/task-board/ws-gateway/internal/push"
)

// ── Fakes ────────────────────────────────────────────────────────────────────

type fakeStore struct {
	mu sync.Mutex
	// calls records the ORDER of operations, which is the durability
	// invariant: the outbox must be written before anything is pushed.
	calls []string

	nodesByUser map[string][]string
	addrs       map[string]string

	outboxUsers []string
	// outboxPayload is the bytes actually persisted. Captured because the
	// per-recipient payload is a cost multiplier, not just a value: whatever
	// lands here is stored once per recipient.
	outboxPayload []byte
	outboxErr     error
	nodesErr      error
	addrsErr      error
	forgot        []string // node ids whose cached address was invalidated
}

func (f *fakeStore) AppendOutboxMulti(_ context.Context, userIDs []string, _ int64, raw []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "outbox")
	f.outboxUsers = append(f.outboxUsers, userIDs...)
	f.outboxPayload = raw
	return f.outboxErr
}

func (f *fakeStore) NodesForUsers(_ context.Context, userIDs []string) (map[string][]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "nodes")
	if f.nodesErr != nil {
		return nil, f.nodesErr
	}
	out := map[string][]string{}
	for _, u := range userIDs {
		if n, ok := f.nodesByUser[u]; ok {
			out[u] = n
		}
	}
	return out, nil
}

func (f *fakeStore) NodeAddrs(_ context.Context, nodeIDs []string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "addrs")
	if f.addrsErr != nil {
		return nil, f.addrsErr
	}
	out := map[string]string{}
	for _, n := range nodeIDs {
		if a, ok := f.addrs[n]; ok {
			out[n] = a
		}
	}
	return out, nil
}

func (f *fakeStore) ForgetNodeAddr(nodeID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgot = append(f.forgot, nodeID)
}

type fakePusher struct {
	mu sync.Mutex
	// sent maps addr -> userIDs delivered there, in arrival order.
	sent map[string][]string
	// calls counts push REQUESTS as distinct from the deliveries inside
	// them — the batching factor is the whole point of grouping by node.
	calls int
	// payload is the bytes carried on the last delivery, so a test can assert
	// what actually reaches a socket.
	payload []byte
	err     error
}

func newFakePusher() *fakePusher { return &fakePusher{sent: map[string][]string{}} }

func (f *fakePusher) Push(_ context.Context, addr string, ds []push.Delivery) (push.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	for _, d := range ds {
		f.sent[addr] = append(f.sent[addr], d.UserID)
		f.payload = d.Payload
	}
	if f.err != nil {
		return push.Result{}, f.err
	}
	return push.Result{Accepted: len(ds)}, nil
}

func testRouter(st Store, p Pusher) *Router {
	return New(st, p, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// event builds a real fan-out event. "message.deleted" routes to `members`
// verbatim (see contract.RecipientsOf), which makes the recipient list explicit.
func event(members ...string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":       "message.deleted",
		"occurredAt": "2026-08-14T10:00:00Z",
		"members":    members,
	})
	return b
}

// ── Tests ────────────────────────────────────────────────────────────────────

// The point of routed delivery: a node holding four of the recipients receives
// ONE request carrying four deliveries, not four requests — and a node holding
// none of them is not contacted at all.
func TestRouteBatchesPerNodeAndSkipsNodesWithNoRecipients(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{
			"u1": {"nodeA"},
			"u2": {"nodeA"},
			"u3": {"nodeB"},
		},
		addrs: map[string]string{
			"nodeA": "http://a:8080",
			"nodeB": "http://b:8080",
			"nodeC": "http://c:8080", // holds nobody in this event
		},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1", "u2", "u3"))

	if p.calls != 2 {
		t.Errorf("made %d push requests, want 2 (one per node holding a recipient)", p.calls)
	}
	if got := sorted(p.sent["http://a:8080"]); len(got) != 2 || got[0] != "u1" || got[1] != "u2" {
		t.Errorf("nodeA got %v, want [u1 u2] in a single batch", got)
	}
	if got := p.sent["http://b:8080"]; len(got) != 1 || got[0] != "u3" {
		t.Errorf("nodeB got %v, want [u3]", got)
	}
	if _, contacted := p.sent["http://c:8080"]; contacted {
		t.Error("pushed to a node holding none of the recipients — that is the " +
			"broadcast behaviour this replaces")
	}
}

// Durability before delivery. If a push could precede the outbox write, a crash
// between the two would leave a delivery on the wire that no reconnect could
// recover — which is exactly the window the ordering exists to close.
func TestOutboxIsWrittenBeforeAnythingIsPushed(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"nodeA"}},
		addrs:       map[string]string{"nodeA": "http://a:8080"},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1"))

	if len(st.calls) == 0 || st.calls[0] != "outbox" {
		t.Fatalf("call order was %v; the outbox write must come first", st.calls)
	}
}

// A user on a laptop and a phone is held by two nodes, and both must be told —
// each fans out only to the sockets it has.
func TestRecipientOnTwoNodesIsPushedToBoth(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"nodeA", "nodeB"}},
		addrs:       map[string]string{"nodeA": "http://a:8080", "nodeB": "http://b:8080"},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1"))

	if len(p.sent["http://a:8080"]) != 1 || len(p.sent["http://b:8080"]) != 1 {
		t.Errorf("delivered to %v, want one delivery on each of the user's two nodes", p.sent)
	}
}

// An offline audience is the ordinary case, not a failure: the events are in
// the outbox and replay on reconnect. Nothing should be pushed, and — the part
// that matters — the outbox must still have been written.
func TestOfflineRecipientsAreStillPersistedButNotPushed(t *testing.T) {
	st := &fakeStore{nodesByUser: map[string][]string{}} // nobody online
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1", "u2"))

	if p.calls != 0 {
		t.Errorf("made %d push requests for an entirely offline audience, want 0", p.calls)
	}
	if got := sorted(st.outboxUsers); len(got) != 2 || got[0] != "u1" || got[1] != "u2" {
		t.Errorf("outbox users %v, want both recipients persisted for replay", got)
	}
}

// A node whose registration expired between the presence read and the address
// lookup is skipped rather than crashing the event. Its users' events are in
// the outbox; the other nodes must still receive theirs.
func TestNodeWithNoAddressIsSkippedWithoutLosingOthers(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"gone"}, "u2": {"nodeB"}},
		addrs:       map[string]string{"nodeB": "http://b:8080"}, // "gone" expired
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1", "u2"))

	if p.calls != 1 {
		t.Errorf("made %d push requests, want 1 — the live node must still be served", p.calls)
	}
	if got := p.sent["http://b:8080"]; len(got) != 1 || got[0] != "u2" {
		t.Errorf("nodeB got %v, want [u2]", got)
	}
}

// Node addresses are served from an in-process cache, so a push that fails has
// to invalidate the entry. Otherwise a pod that has been replaced keeps
// attracting every event for its former users until the TTL runs out — and this
// is the highest-volume push path in the system.
func TestAFailedPushInvalidatesTheCachedAddress(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"nodeA"}, "u2": {"nodeB"}},
		addrs:       map[string]string{"nodeA": "http://a:8080", "nodeB": "http://b:8080"},
	}
	p := newFakePusher()
	p.err = errStub{}
	testRouter(st, p).Route(context.Background(), event("u1", "u2"))

	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.forgot) != 2 {
		t.Errorf("invalidated %v, want both nodes — each failed push is its own "+
			"evidence about its own address", st.forgot)
	}
}

func TestASuccessfulPushKeepsTheCachedAddress(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"nodeA"}},
		addrs:       map[string]string{"nodeA": "http://a:8080"},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1"))

	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.forgot) != 0 {
		t.Errorf("invalidated %v after a successful push — the cache would never "+
			"hold anything", st.forgot)
	}
}

// A Redis failure on the outbox write must not cancel delivery to people who
// are online. They lose the replay copy, not the message.
func TestOutboxFailureStillDelivers(t *testing.T) {
	st := &fakeStore{
		outboxErr:   errStub{},
		nodesByUser: map[string][]string{"u1": {"nodeA"}},
		addrs:       map[string]string{"nodeA": "http://a:8080"},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1"))

	if p.calls != 1 {
		t.Errorf("made %d push requests after an outbox error, want 1 — an online "+
			"recipient should still receive the event", p.calls)
	}
}

// A routing-table read failure stops the event rather than guessing. The outbox
// is already written, so every recipient still gets it on reconnect.
func TestRoutingLookupFailureDoesNotPush(t *testing.T) {
	st := &fakeStore{nodesErr: errStub{}}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1"))

	if p.calls != 0 {
		t.Errorf("pushed %d times despite an unreadable routing table", p.calls)
	}
	if len(st.outboxUsers) != 1 {
		t.Error("the outbox write must still have happened; it is what makes the " +
			"failure recoverable")
	}
}

// Events with no recipients (internal-only types) must touch nothing at all.
func TestEventWithNoRecipientsDoesNothing(t *testing.T) {
	st := &fakeStore{}
	p := newFakePusher()
	raw, _ := json.Marshal(map[string]any{"type": "user.created", "occurredAt": "2026-08-14T10:00:00Z"})
	testRouter(st, p).Route(context.Background(), raw)

	if len(st.calls) != 0 || p.calls != 0 {
		t.Errorf("internal-only event caused %v and %d pushes, want none", st.calls, p.calls)
	}
}

// Unparseable input is skipped, not fatal: one malformed message must not stall
// the partition behind it.
func TestUnparseableEventIsSkipped(t *testing.T) {
	st := &fakeStore{}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), []byte(`{not json`))

	if len(st.calls) != 0 || p.calls != 0 {
		t.Error("a malformed event did work; it should be dropped")
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func sorted(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

type errStub struct{}

func (errStub) Error() string { return "stub" }

// ── Routing metadata must not be stored or transmitted per recipient ─────────
//
// `members` exists so RecipientsOf can answer "who gets this". Once it has, the
// field is dead weight — and it is dead weight that gets multiplied, because
// every recipient's outbox holds its own copy. A channel roster shipped inside
// the event therefore costs O(N²) bytes for one message.
//
// Routing the event properly removes the per-POD duplication but not this one,
// so the strip has to happen here too, not only in the broadcast consumer.
func TestRosterIsStrippedFromWhatIsStoredAndPushed(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"nodeA"}},
		addrs:       map[string]string{"nodeA": "http://a"},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1", "u2", "u3"))

	for name, got := range map[string][]byte{
		"outbox": st.outboxPayload,
		"push":   p.payload,
	} {
		if got == nil {
			t.Fatalf("%s: nothing captured", name)
		}
		var fields map[string]any
		if err := json.Unmarshal(got, &fields); err != nil {
			t.Fatalf("%s: payload is not valid JSON: %v", name, err)
		}
		if _, present := fields["members"]; present {
			t.Errorf("%s: roster survived — fan-out is still quadratic in channel size", name)
		}
		// The strip must not take the event with it.
		if fields["type"] != "message.deleted" {
			t.Errorf("%s: lost the event type: %v", name, fields)
		}
		if fields["occurredAt"] != "2026-08-14T10:00:00Z" {
			t.Errorf("%s: lost occurredAt: %v", name, fields)
		}
	}
}

// The ordering invariant behind the strip: recipients are computed from the
// ORIGINAL event, so stripping early would route the message to nobody.
func TestStrippingDoesNotCostRecipients(t *testing.T) {
	st := &fakeStore{
		nodesByUser: map[string][]string{"u1": {"nodeA"}, "u2": {"nodeA"}, "u3": {"nodeB"}},
		addrs:       map[string]string{"nodeA": "http://a", "nodeB": "http://b"},
	}
	p := newFakePusher()
	testRouter(st, p).Route(context.Background(), event("u1", "u2", "u3"))

	if len(st.outboxUsers) != 3 {
		t.Errorf("outbox got %d recipients, want 3: %v", len(st.outboxUsers), st.outboxUsers)
	}
	if n := len(p.sent["http://a"]) + len(p.sent["http://b"]); n != 3 {
		t.Errorf("pushed to %d recipients, want 3: %v", n, p.sent)
	}
}
