package backoff

import (
	"context"
	"testing"
	"time"
)

func TestDelayGrowsAndThenStopsGrowing(t *testing.T) {
	p := Policy{Base: 10 * time.Millisecond, Max: 100 * time.Millisecond}
	for attempt := 1; attempt <= 200; attempt++ {
		d := p.Delay(attempt)
		if d < 0 {
			t.Fatalf("attempt %d: negative delay %v", attempt, d)
		}
		if d >= p.Max {
			t.Fatalf("attempt %d: delay %v exceeded the cap %v", attempt, d, p.Max)
		}
	}
}

func TestALongOutageDoesNotOverflowIntoABusyLoop(t *testing.T) {
	// The bug this guards: an unclamped exponent is +Inf as a float and
	// undefined as a shift, either of which yields a non-positive Duration —
	// and a non-positive sleep turns a backoff into a tight retry loop against
	// a component that is already struggling.
	p := Policy{Base: time.Second, Max: 30 * time.Second}
	for _, attempt := range []int{63, 64, 65, 1000, 1 << 20} {
		if d := p.Delay(attempt); d <= 0 || d >= p.Max {
			t.Fatalf("attempt %d: delay %v is outside (0, %v)", attempt, d, p.Max)
		}
	}
}

func TestZeroValuePolicyFallsBackToTheDefault(t *testing.T) {
	var p Policy
	if d := p.Delay(1); d < 0 || d >= Default.Max {
		t.Fatalf("zero policy produced %v", d)
	}
}

func TestSleepReportsCancellationRatherThanWaitingItOut(t *testing.T) {
	p := Policy{Base: time.Hour, Max: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if p.Sleep(ctx.Done(), 5) {
		t.Fatal("Sleep reported a completed wait on a cancelled context")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Sleep waited %v on a cancelled context — shutdown would hang", elapsed)
	}
}

func TestJitterActuallyVaries(t *testing.T) {
	// A fleet that retries in lockstep is the failure this package exists for,
	// so identical delays across draws would defeat the whole point.
	p := Policy{Base: time.Second, Max: 8 * time.Second}
	seen := make(map[time.Duration]bool)
	for i := 0; i < 50; i++ {
		seen[p.Delay(6)] = true
	}
	if len(seen) < 10 {
		t.Fatalf("only %d distinct delays in 50 draws — the jitter is not working", len(seen))
	}
}
