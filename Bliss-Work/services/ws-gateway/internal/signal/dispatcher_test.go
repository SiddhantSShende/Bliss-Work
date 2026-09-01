package signal

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// ── Fakes ────────────────────────────────────────────────────────────────────

// fakeChecker answers the same-org online question from a controlled table and
// counts how often it was asked — which is what the cache is for.
type fakeChecker struct {
	mu     sync.Mutex
	online map[string]bool // "org\x00user" -> is an online member
	err    error
	calls  int
}

func (f *fakeChecker) IsOnlineInOrg(_ context.Context, orgID, userID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return false, f.err
	}
	return f.online[orgID+"\x00"+userID], nil
}

func (f *fakeChecker) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// fakeBlocks answers the block question from a controlled table and counts
// how often it was asked — CallInviteAllowed has no cache in front of it (see
// its doc comment), so every call.invite must reach this fake exactly once.
type fakeBlocks struct {
	mu      sync.Mutex
	blocked map[string]bool // "userA\x00userB", checked both orderings
	err     error
	calls   int
}

func (f *fakeBlocks) IsBlocked(_ context.Context, _ string, userA, userB string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return false, f.err
	}
	return f.blocked[userA+"\x00"+userB] || f.blocked[userB+"\x00"+userA], nil
}

func (f *fakeBlocks) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func newDispatcher(c PresenceChecker) *Dispatcher {
	return New(hub.New(), c, &fakeBlocks{}, nil, discardLog())
}

// unreachableStore returns a real Store whose Redis dials a closed local port,
// with tight timeouts so calls fail fast instead of hanging the test.
func unreachableStore(t *testing.T) *store.Store {
	t.Helper()
	// dial_timeout/read_timeout query params are honored by redis.ParseURL.
	st, err := store.New("redis://127.0.0.1:1/0?dial_timeout=200ms&read_timeout=200ms")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	return st
}

func offer() Frame { return Frame{Type: "rtc.offer", OfferID: "o1"} }

// ── The cross-org gate ───────────────────────────────────────────────────────

func TestForwardDeliversToASameOrgOnlinePeer(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{"org-1\x00u-to": true}}
	d := newDispatcher(c)
	target := hub.NewConn("u-to", "c-to")
	if !d.hub.Add(target, 0, 0) {
		t.Fatal("failed to register target conn")
	}

	if !d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Fatal("Forward refused a same-org online peer")
	}
	select {
	case <-target.Send:
	default:
		t.Error("nothing was enqueued to the target socket")
	}
}

// The gate itself: a peer who is online, but in a DIFFERENT org, is reported
// unreachable — indistinguishable from offline, so nothing leaks about who
// exists elsewhere.
func TestForwardRefusesACrossOrgPeer(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{"org-2\x00u-to": true}} // online in org-2
	d := newDispatcher(c)
	target := hub.NewConn("u-to", "c-to")
	d.hub.Add(target, 0, 0)

	if d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Fatal("a sender in org-1 reached a peer who is only online in org-2")
	}
	select {
	case raw := <-target.Send:
		t.Fatalf("frame leaked across the org boundary: %s", raw)
	default:
	}
}

func TestForwardRefusesAnOfflinePeer(t *testing.T) {
	d := newDispatcher(&fakeChecker{online: map[string]bool{}})
	if d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Error("Forward claimed delivery to a peer who is online nowhere")
	}
}

func TestForwardFailsClosedWhenTheCheckErrors(t *testing.T) {
	d := newDispatcher(&fakeChecker{err: errors.New("redis down")})
	target := hub.NewConn("u-to", "c-to")
	d.hub.Add(target, 0, 0)

	if d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Fatal("Forward must fail closed when it cannot prove the peer is same-org")
	}
	select {
	case raw := <-target.Send:
		t.Fatalf("frame delivered to a local socket without a passing org check: %s", raw)
	default:
	}
}

// The same property against the real Store, so the fake above cannot drift from
// what an actual Redis outage does.
func TestForwardFailsClosedAgainstAnUnreachableRedis(t *testing.T) {
	d := newDispatcher(unreachableStore(t))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if d.Forward(ctx, "org-1", "u-from", "u-to", offer()) {
		t.Fatal("Forward returned true with Redis unreachable")
	}
}

// ── The peer cache ───────────────────────────────────────────────────────────

// An offer, an answer and a trickle of ICE candidates are one question asked
// many times. It must reach Redis once.
func TestRepeatedFramesToOnePeerCheckPresenceOnce(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{"org-1\x00u-to": true}}
	d := newDispatcher(c)
	d.hub.Add(hub.NewConn("u-to", "c-to"), 0, 0)

	for i := 0; i < 40; i++ {
		d.Forward(context.Background(), "org-1", "u-from", "u-to", Frame{
			Type: "rtc.ice", OfferID: "o1", Candidate: "cand",
		})
	}
	if got := c.callCount(); got != 1 {
		t.Errorf("checked presence %d times for 40 frames to one peer, want 1 — "+
			"the trickle of ICE candidates is what this cache exists for", got)
	}
}

// Each destination is its own question.
func TestDistinctPeersAreCheckedSeparately(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{
		"org-1\x00u-a": true,
		"org-1\x00u-b": true,
	}}
	d := newDispatcher(c)

	d.Forward(context.Background(), "org-1", "u-from", "u-a", offer())
	d.Forward(context.Background(), "org-1", "u-from", "u-b", offer())
	d.Forward(context.Background(), "org-1", "u-from", "u-a", offer())

	if got := c.callCount(); got != 2 {
		t.Errorf("made %d checks for two distinct peers, want 2", got)
	}
}

// THE SECURITY PROPERTY OF THE CACHE. The org is part of the cache key, so a
// positive answer for one org can never be served to a sender in another. If
// the key were the user id alone, one legitimate same-org call would poison the
// cache into admitting every other org's traffic to that user.
func TestACachedAllowIsNotReusedAcrossOrgs(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{"org-1\x00u-to": true}}
	d := newDispatcher(c)
	target := hub.NewConn("u-to", "c-to")
	d.hub.Add(target, 0, 0)

	// Warm the cache with a legitimate same-org send.
	if !d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Fatal("the same-org send that warms the cache did not deliver")
	}
	<-target.Send

	// A different org now asks about the same user.
	if d.Forward(context.Background(), "org-2", "u-attacker", "u-to", offer()) {
		t.Fatal("a cached same-org allow was served to a sender in another org")
	}
	select {
	case raw := <-target.Send:
		t.Fatalf("cross-org frame delivered from a poisoned cache: %s", raw)
	default:
	}
}

// Denials are never cached: a peer who was offline a moment ago is one
// heartbeat from being online, and a user retrying a failed call deserves a
// live answer rather than a remembered refusal.
func TestDenialsAreNotCached(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{}}
	d := newDispatcher(c)

	for i := 0; i < 3; i++ {
		d.Forward(context.Background(), "org-1", "u-from", "u-to", offer())
	}
	if got := c.callCount(); got != 3 {
		t.Errorf("made %d checks for 3 sends to an offline peer, want 3 — "+
			"caching a denial would keep refusing a peer who has since come online", got)
	}

	// And the moment they come online, the very next frame gets through.
	c.mu.Lock()
	c.online["org-1\x00u-to"] = true
	c.mu.Unlock()
	d.hub.Add(hub.NewConn("u-to", "c-to"), 0, 0)

	if !d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Error("a peer who came online was still refused")
	}
}

// An error must not be cached as a denial either, or one Redis blip would
// suppress signalling for the whole TTL.
func TestErrorsAreNotCached(t *testing.T) {
	c := &fakeChecker{err: errors.New("redis down")}
	d := newDispatcher(c)

	d.Forward(context.Background(), "org-1", "u-from", "u-to", offer())
	c.mu.Lock()
	c.err = nil
	c.online = map[string]bool{"org-1\x00u-to": true}
	c.mu.Unlock()
	d.hub.Add(hub.NewConn("u-to", "c-to"), 0, 0)

	if !d.Forward(context.Background(), "org-1", "u-from", "u-to", offer()) {
		t.Error("a transient error was remembered as a refusal")
	}
}

// A cached allow expires, so a peer who leaves the org stops being reachable
// without waiting for the process to restart.
func TestACachedAllowExpires(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{"org-1\x00u-to": true}}
	d := newDispatcher(c)
	d.hub.Add(hub.NewConn("u-to", "c-to"), 0, 0)

	d.Forward(context.Background(), "org-1", "u-from", "u-to", offer())
	d.peers.Forget("org-1\x00u-to") // stand in for the TTL elapsing
	d.Forward(context.Background(), "org-1", "u-from", "u-to", offer())

	if got := c.callCount(); got != 2 {
		t.Errorf("made %d checks, want 2 — an expired entry must be re-read", got)
	}
}

// ── Frame handling ───────────────────────────────────────────────────────────

// The recipient is told who sent the frame, from the verified JWT claims, and
// never anything the client put in `toUserId`.
func TestForwardStampsTheSenderAndStripsTheDestination(t *testing.T) {
	c := &fakeChecker{online: map[string]bool{"org-1\x00u-to": true}}
	d := newDispatcher(c)
	target := hub.NewConn("u-to", "c-to")
	d.hub.Add(target, 0, 0)

	d.Forward(context.Background(), "org-1", "u-from", "u-to", Frame{
		Type:     "rtc.offer",
		OfferID:  "o1",
		ToUserID: "someone-else", // a client-supplied value that must not survive
	})

	raw := string(<-target.Send)
	if !strings.Contains(raw, `"fromUserId":"u-from"`) {
		t.Errorf("frame %s does not carry the sender from the JWT claims", raw)
	}
	if strings.Contains(raw, "someone-else") || strings.Contains(raw, `"toUserId"`) {
		t.Errorf("frame %s still carries a destination; the recipient's own id is implicit", raw)
	}
}

// ── CallInviteAllowed (P0-A: blocked users must not be able to call) ─────────

func TestCallInviteAllowed_TrueWithNoBlock(t *testing.T) {
	d := newDispatcher(&fakeChecker{})
	d.blocks = &fakeBlocks{blocked: map[string]bool{}}

	allowed, err := d.CallInviteAllowed(context.Background(), "org-1", "u-a", "u-b")
	if err != nil || !allowed {
		t.Fatalf("CallInviteAllowed with no block = (%v, %v), want (true, nil)", allowed, err)
	}
}

// Test 1: caller blocks recipient.
func TestCallInviteAllowed_FalseWhenCallerBlockedRecipient(t *testing.T) {
	d := newDispatcher(&fakeChecker{})
	d.blocks = &fakeBlocks{blocked: map[string]bool{"u-caller\x00u-recipient": true}}

	allowed, err := d.CallInviteAllowed(context.Background(), "org-1", "u-caller", "u-recipient")
	if err != nil || allowed {
		t.Fatalf("CallInviteAllowed(caller, recipient) after caller blocked recipient = (%v, %v), want (false, nil)", allowed, err)
	}
}

// Test 2: recipient blocks caller — the check must catch the reverse
// direction too, exactly like messaging's bool_or(blocked) rule.
func TestCallInviteAllowed_FalseWhenRecipientBlockedCaller(t *testing.T) {
	d := newDispatcher(&fakeChecker{})
	// The block row names (recipient, caller) — the fake stores it in the
	// order it was set, IsBlocked below asks it in the (caller, recipient)
	// order the dispatcher always uses.
	fb := &fakeBlocks{blocked: map[string]bool{}}
	fb.blocked["u-recipient\x00u-caller"] = true
	d.blocks = fb

	allowed, err := d.CallInviteAllowed(context.Background(), "org-1", "u-caller", "u-recipient")
	if err != nil || allowed {
		t.Fatalf("CallInviteAllowed(caller, recipient) after recipient blocked caller = (%v, %v), want (false, nil)", allowed, err)
	}
}

// Fails closed: an error from messaging-svc must never be treated as "allowed."
func TestCallInviteAllowed_FailsClosedOnError(t *testing.T) {
	d := newDispatcher(&fakeChecker{})
	d.blocks = &fakeBlocks{err: errors.New("messaging-svc unreachable")}

	allowed, err := d.CallInviteAllowed(context.Background(), "org-1", "u-a", "u-b")
	if err == nil || allowed {
		t.Fatalf("CallInviteAllowed on a block-check error = (%v, %v), want (false, non-nil)", allowed, err)
	}
}
