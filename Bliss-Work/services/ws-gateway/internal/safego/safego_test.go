package safego

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a bytes.Buffer safe for concurrent Write (from the goroutine
// under test, via the slog handler) and String (from the test goroutine
// polling for the result).
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// TestGoRecoversPanicAndLogs proves the exact failure mode Bug 2 describes: a
// panic on a detached goroutine must not propagate to the runtime (which would
// kill the whole process, and with it every other goroutine — every open
// WebSocket on the node) and must be logged with enough context to find it.
func TestGoRecoversPanicAndLogs(t *testing.T) {
	buf := &syncBuffer{}
	log := slog.New(slog.NewTextHandler(buf, nil))

	Go(log, "test.panicking-goroutine", func() {
		panic("boom")
	})

	out := waitForLog(buf, time.Second)
	if out == "" {
		t.Fatal("goroutine panic was never recovered and logged")
	}
	if !strings.Contains(out, "panic recovered in goroutine") {
		t.Errorf("log missing recovery message, got: %s", out)
	}
	if !strings.Contains(out, "test.panicking-goroutine") {
		t.Errorf("log missing goroutine name, got: %s", out)
	}
	if !strings.Contains(out, "boom") {
		t.Errorf("log missing recovered panic value, got: %s", out)
	}
	if !strings.Contains(out, "goroutine ") { // runtime/debug.Stack() output starts with this
		t.Errorf("log missing stack trace, got: %s", out)
	}
}

// TestGoRunsFnWithoutPanicking confirms Go does not alter behavior for the
// ordinary, non-panicking case.
func TestGoRunsFnWithoutPanicking(t *testing.T) {
	log := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	done := make(chan struct{})
	Go(log, "test.ok", func() { close(done) })

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("fn never ran")
	}
}

// TestGuardRecoversWithoutSpawning proves Guard gives call sites that must
// keep their own `go func(){}()` (e.g. to release a semaphore or call
// WaitGroup.Done afterwards) the same panic safety as Go, synchronously in the
// calling goroutine.
func TestGuardRecoversWithoutSpawning(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))

	cleanupRan := false
	func() {
		defer func() { cleanupRan = true }() // stands in for wg.Done()/sem release
		Guard(log, "test.guarded", func() {
			panic("boom")
		})
	}()

	if !cleanupRan {
		t.Error("caller's own deferred cleanup did not run after a recovered panic")
	}
	if !strings.Contains(buf.String(), "test.guarded") {
		t.Errorf("log missing goroutine name, got: %s", buf.String())
	}
}

// TestGuardRunsFnWithoutPanicking confirms Guard does not alter behavior for
// the ordinary, non-panicking case.
func TestGuardRunsFnWithoutPanicking(t *testing.T) {
	log := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	ran := false
	Guard(log, "test.ok", func() { ran = true })
	if !ran {
		t.Error("fn did not run")
	}
}

// waitForLog polls buf until it is non-empty or timeout elapses. The
// recovered panic is logged from the goroutine under test, asynchronously to
// this one, so the assertions below must wait for it rather than assume it
// has already happened.
func waitForLog(buf *syncBuffer, timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if out := buf.String(); out != "" {
			return out
		}
		time.Sleep(time.Millisecond)
	}
	return ""
}
