package middleware

import (
	"net/http/httptest"
	"testing"
)

// The per-IP limiter is only as good as the address it keys on, and this file
// exists because a load test measured the failure rather than reasoning about it:
// against a directly-reachable messaging-svc, 500 requests from one source with
// no header were rate-limited 212 times, and 500 identical requests carrying a
// varying `X-Forwarded-For` were rate-limited ZERO times.
//
// Through Caddy that is safe — Caddy APPENDS the address it observed, so the
// rightmost entry is our own edge's observation rather than the client's claim.
// The defect was that the hop count was a hardcoded 1 with a comment asking a
// future reader to change it by hand if the topology ever gained a proxy. A
// trust model that cannot be configured is one that silently stops holding.
//
// The four Python services already take TRUSTED_PROXY_HOPS. These assertions
// pin the Go semantics to the SAME rule so the two halves cannot drift.

// clientIPFor is a thin harness so each case reads as data.
func clientIPFor(t *testing.T, xff, remoteAddr string) string {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/v1/conversations", nil)
	r.RemoteAddr = remoteAddr
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	return clientIP(r)
}

func TestOneHopReadsTheEdgeObservation(t *testing.T) {
	SetTrustedProxyHops(1)
	t.Cleanup(func() { SetTrustedProxyHops(1) })

	// Caddy appended its observation of the real client. That last entry is the
	// only one anybody we run actually saw.
	got := clientIPFor(t, "203.0.113.9", "172.18.0.5:41000")
	if got != "203.0.113.9" {
		t.Errorf("clientIP = %q, want the edge-observed address", got)
	}
}

func TestSpoofedPrefixCannotMintFreshBuckets(t *testing.T) {
	SetTrustedProxyHops(1)
	t.Cleanup(func() { SetTrustedProxyHops(1) })

	// THE MEASURED ATTACK. A caller varying the left-hand entries must land in
	// the SAME bucket every time, or the limiter has no effect at all — which is
	// precisely what "0 of 500 rate-limited" looked like.
	a := clientIPFor(t, "1.1.1.1, 203.0.113.9", "172.18.0.5:41000")
	b := clientIPFor(t, "2.2.2.2, 203.0.113.9", "172.18.0.5:41000")
	c := clientIPFor(t, "9.9.9.9, 8.8.8.8, 203.0.113.9", "172.18.0.5:41000")
	if a != b || b != c {
		t.Fatalf("a spoofed prefix changed the bucket key: %q / %q / %q — the "+
			"per-IP limiter can be bypassed by setting a header", a, b, c)
	}
}

func TestTwoHopsSkipsTheSecondProxy(t *testing.T) {
	// The case the old hardcoded 1 could not express: a load balancer in front
	// of Caddy. With two hops the rightmost entry is the LB's view of Caddy,
	// which is useless for limiting; the one before it is the real client.
	SetTrustedProxyHops(2)
	t.Cleanup(func() { SetTrustedProxyHops(1) })

	got := clientIPFor(t, "203.0.113.9, 10.0.0.7", "172.18.0.5:41000")
	if got != "203.0.113.9" {
		t.Errorf("clientIP = %q with 2 hops, want the client address", got)
	}
}

func TestFewerEntriesThanHopsFallsBackToThePeer(t *testing.T) {
	// A request that did not traverse the expected topology. Falling back to the
	// peer NARROWS the bucket; trusting a short header would widen it to
	// whatever the caller supplied. Fail safe means narrow.
	SetTrustedProxyHops(2)
	t.Cleanup(func() { SetTrustedProxyHops(1) })

	got := clientIPFor(t, "203.0.113.9", "172.18.0.5:41000")
	if got != "172.18.0.5" {
		t.Errorf("clientIP = %q, want the direct peer when the header is shorter "+
			"than the configured hop count", got)
	}
}

func TestZeroHopsIgnoresTheHeaderEntirely(t *testing.T) {
	// Correct for a service exposed with no proxy at all: the header is then
	// pure caller input and must not be believed under any circumstances.
	SetTrustedProxyHops(0)
	t.Cleanup(func() { SetTrustedProxyHops(1) })

	got := clientIPFor(t, "1.1.1.1, 203.0.113.9", "172.18.0.5:41000")
	if got != "172.18.0.5" {
		t.Errorf("clientIP = %q with 0 hops, want the peer — the header must be "+
			"ignored when nothing trustworthy sets it", got)
	}
}

func TestNoHeaderUsesThePeer(t *testing.T) {
	SetTrustedProxyHops(1)
	got := clientIPFor(t, "", "10.1.2.3:5555")
	if got != "10.1.2.3" {
		t.Errorf("clientIP = %q, want the peer address", got)
	}
}

func TestTwoRealCallersDoNotShareABucket(t *testing.T) {
	// The other direction, and the reason a too-LOW hop count is merely bad
	// rather than dangerous: distinct callers must key distinctly.
	SetTrustedProxyHops(1)
	one := clientIPFor(t, "203.0.113.9", "172.18.0.5:41000")
	two := clientIPFor(t, "198.51.100.4", "172.18.0.5:41000")
	if one == two {
		t.Error("two distinct callers share a bucket key")
	}
}

func TestMalformedHeaderDoesNotPanicOrWiden(t *testing.T) {
	SetTrustedProxyHops(1)
	for _, xff := range []string{",", " , , ", ",,203.0.113.9", "203.0.113.9,"} {
		got := clientIPFor(t, xff, "172.18.0.5:41000")
		if got == "" {
			t.Errorf("xff %q produced an empty key", xff)
		}
	}
}
