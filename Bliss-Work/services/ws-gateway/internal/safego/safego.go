// Package safego runs detached goroutine bodies with panic recovery.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A panic on the main goroutine (or inside an HTTP handler wrapped by the
// server's recoverer, see internal/server/requestid.go) is caught well short
// of crashing the process. A panic on a bare `go f()` goroutine is not: nothing
// is above it on the call stack to recover it, so it terminates the whole
// process — every open WebSocket on that node included — over something as
// small as a nil map lookup in one delivery.
//
// Every long-running or fire-and-forget goroutine in this module should be
// started through Go, or (when the call site already owns the `go` statement
// for its own reasons — closure captures, an existing WaitGroup/semaphore
// release) should wrap its risky body in Guard instead.
package safego

import (
	"log/slog"
	"runtime/debug"
)

// Go runs fn in a new goroutine. A panic inside fn is recovered, logged at
// ERROR under name with the recovered value and a stack trace, and then
// swallowed — it never reaches the runtime and never crashes the process.
//
// name identifies the goroutine in the log (e.g. "ws-gateway.fanout-consumer")
// so a recovered panic can be traced back to which long-running loop produced
// it.
func Go(log *slog.Logger, name string, fn func()) {
	go func() {
		defer recoverAndLog(log, name)
		fn()
	}()
}

// Guard runs fn with the same panic recovery as Go, without spawning a new
// goroutine itself. For call sites that must keep their own `go func(){}()`
// statement — typically because they close over per-iteration loop variables
// or already defer cleanup (a WaitGroup.Done, a semaphore release) that must
// still run after a recovered panic — wrap only the risky body in Guard so
// those existing defers are unaffected.
func Guard(log *slog.Logger, name string, fn func()) {
	defer recoverAndLog(log, name)
	fn()
}

// recoverAndLog is deferred directly by Go and Guard (never called through an
// intermediate function) so recover() inside it actually stops the panic —
// recover only has an effect when invoked directly by a deferred function.
func recoverAndLog(log *slog.Logger, name string) {
	if rec := recover(); rec != nil {
		log.Error("panic recovered in goroutine",
			"goroutine", name,
			"panic", rec,
			"stack", string(debug.Stack()),
		)
	}
}
