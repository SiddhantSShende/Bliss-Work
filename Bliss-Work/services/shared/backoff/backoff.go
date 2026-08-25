// Package backoff is a capped exponential retry schedule with full jitter,
// shared by every Go service that needs to retry a flaky call without every
// replica retrying in lockstep.
//
// Originally region-bridge-only (a WAN partition or a broker election fails
// every replica of the bridge at once, and a fixed delay would have the whole
// fleet retry in lockstep and hit the recovering component with a
// synchronised thundering herd — the jitter is the point of the package, not
// a detail of it). ws-gateway's delivery dispatcher had reimplemented the same
// algorithm independently; this is the one copy both now use.
package backoff

import (
	"math"
	"math/rand/v2"
	"time"
)

// Policy is a capped exponential schedule with full jitter.
type Policy struct {
	Base time.Duration
	Max  time.Duration
}

// Default is sized for region-bridge's failures: a broker election (seconds),
// a NATS reconnect (seconds), a WAN blip (tens of seconds). Callers with a
// different failure profile (e.g. a short-lived per-request retry loop)
// should construct their own Policy rather than use this one.
var Default = Policy{Base: 250 * time.Millisecond, Max: 30 * time.Second}

// Delay returns how long to wait before attempt n (1-based).
//
// FULL jitter — a uniform draw over [0, capped) rather than capped/2 + jitter.
// It is the variant that actually decorrelates a fleet: the alternative still
// has every replica retrying inside the same narrow window, which is most of
// the herd it was meant to prevent.
func (p Policy) Delay(attempt int) time.Duration {
	base, max := p.Base, p.Max
	if base <= 0 {
		base = Default.Base
	}
	if max <= 0 || max < base {
		max = Default.Max
	}
	if attempt < 1 {
		attempt = 1
	}
	// Shift rather than math.Pow, and clamp the exponent before it is applied:
	// at attempt 64 an unclamped shift is undefined and at attempt 300 (which a
	// long outage genuinely reaches) a float exponent is +Inf, which converts
	// to a negative Duration and turns the sleep into a busy loop.
	exp := attempt - 1
	if exp > 32 {
		exp = 32
	}
	capped := time.Duration(math.Min(float64(base)*float64(uint64(1)<<uint(exp)), float64(max)))
	if capped <= 0 {
		capped = max
	}
	return time.Duration(rand.Int64N(int64(capped)))
}

// Sleep waits out the delay for `attempt`, or returns early if done is closed.
//
// Takes a plain <-chan struct{} rather than a context.Context so either a
// context's Done() channel or any other cancellation signal works — pass
// ctx.Done() directly.
//
// Returns false when the wait was cut short by cancellation, so a caller can
// tell "the backoff elapsed, try again" from "we are shutting down" — which is
// the difference between a clean stop and one more doomed request on the way
// out.
func (p Policy) Sleep(done <-chan struct{}, attempt int) bool {
	t := time.NewTimer(p.Delay(attempt))
	defer t.Stop()
	select {
	case <-done:
		return false
	case <-t.C:
		return true
	}
}
