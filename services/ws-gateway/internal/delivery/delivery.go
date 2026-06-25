// Package delivery owns the gateway-side translation of client `message.ack`
// frames into POSTs against messaging-svc's internal /delivered endpoint.
//
// Design rationale (Phase 5):
//
//   - The gateway must NOT become a Kafka producer (that would force it to
//     carry its own outbox + DB to preserve exactly-once semantics). Instead
//     we forward the ack to messaging-svc, which already has an outbox, and
//     let it emit the canonical MessageDelivered event from there.
//
//   - We batch acks per (recipient, sender, thread) over a 500 ms window so a
//     receiver who just opened a thread with 50 unread messages doesn't fire
//     50 HTTP calls — one call carries an array of messageIds.
//
//   - The dispatcher is owned by the Server (one instance per process) and is
//     drained on shutdown by closing its context.
package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"sync"
	"time"
)

// flushInterval bounds the per-recipient batching window.
const flushInterval = 500 * time.Millisecond

// httpTimeout caps a single ack POST so a slow messaging-svc can't pin the
// dispatcher goroutine forever. This is the PER-ATTEMPT timeout (enforced by
// http.Client.Timeout); the retry loop below can make up to maxAttempts of
// these back-to-back, plus short backoff sleeps in between.
const httpTimeout = 5 * time.Second

// Retry policy for a single batch POST. The delivered status is a best-effort
// UX signal, so we want a *bounded* number of cheap retries to ride out a
// transient blip (a redeploy, a brief GC pause in messaging-svc) without ever
// blocking the dispatcher's flush loop for long.
const (
	// maxAttempts is the total number of POST attempts (1 initial + 2 retries).
	maxAttempts = 3
	// backoffBase is the first inter-attempt sleep; it doubles each retry.
	backoffBase = 100 * time.Millisecond
	// backoffMax caps any single backoff sleep so the schedule stays short.
	backoffMax = 1 * time.Second
)

// Circuit breaker. When messaging-svc is sustainedly down, retrying every
// batch wastes the full retry budget (and up to maxAttempts*httpTimeout of
// wall-clock) on a call we already know will fail. After cbThreshold
// consecutive failures we OPEN the breaker and fail-fast (drop immediately,
// no HTTP, no retries) for cbCooldown; the first flush after the cooldown is
// a half-open trial that either closes the breaker (success) or re-opens it.
const (
	cbThreshold = 5
	cbCooldown  = 10 * time.Second
)

// maxPendingPerRecipient bounds the per-recipient pending set. A misbehaving
// or compromised client could otherwise spew thousands of fake messageIds per
// second; the per-frame cap (64) is not enough on its own. New ids beyond the
// cap are silently dropped — losing a "delivered" status is a soft failure.
const maxPendingPerRecipient = 1024

// Dispatcher batches delivery acks per recipient and ships them to messaging-svc.
type Dispatcher struct {
	baseURL string
	token   string
	client  *http.Client
	log     *slog.Logger

	mu      sync.Mutex
	pending map[string]*batch // key = recipientUserId

	// cbMu guards the circuit-breaker counters. Kept separate from mu so a POST
	// in flight never holds the lock that Ack() needs to enqueue new acks.
	cbMu        sync.Mutex
	cbFailures  int       // consecutive failed flushes
	cbOpenUntil time.Time // breaker is open (fail-fast) until this instant
}

type batch struct {
	recipientID string
	msgIDs      map[string]struct{} // dedupe within a window
	first       time.Time
}

// New constructs a Dispatcher. Caller MUST call Run(ctx) once.
func New(baseURL, token string, log *slog.Logger) *Dispatcher {
	return &Dispatcher{
		baseURL: baseURL,
		token:   token,
		client:  &http.Client{Timeout: httpTimeout},
		log:     log,
		pending: make(map[string]*batch),
	}
}

// Run drives the periodic flush; returns when ctx is done.
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(flushInterval / 2)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			// Use a fresh context for the shutdown drain so an already-done
			// parent doesn't immediately abort the final HTTP call.
			d.flushAll(context.Background())
			return
		case <-ticker.C:
			d.flushDue(ctx)
		}
	}
}

// Ack queues a (recipient, messageId) pair for the next flush. Safe to call
// from multiple goroutines.
func (d *Dispatcher) Ack(recipientID, messageID string) {
	if recipientID == "" || messageID == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	b, ok := d.pending[recipientID]
	if !ok {
		b = &batch{recipientID: recipientID, msgIDs: make(map[string]struct{}), first: time.Now()}
		d.pending[recipientID] = b
	}
	if len(b.msgIDs) >= maxPendingPerRecipient {
		return
	}
	b.msgIDs[messageID] = struct{}{}
}

func (d *Dispatcher) flushDue(ctx context.Context) {
	d.mu.Lock()
	due := make([]*batch, 0)
	for k, b := range d.pending {
		if time.Since(b.first) >= flushInterval {
			due = append(due, b)
			delete(d.pending, k)
		}
	}
	d.mu.Unlock()

	for _, b := range due {
		d.send(ctx, b)
	}
}

func (d *Dispatcher) flushAll(ctx context.Context) {
	d.mu.Lock()
	all := make([]*batch, 0, len(d.pending))
	for k, b := range d.pending {
		all = append(all, b)
		delete(d.pending, k)
	}
	d.mu.Unlock()
	for _, b := range all {
		d.send(ctx, b)
	}
}

type ackBody struct {
	RecipientID string   `json:"recipientId"`
	MessageIDs  []string `json:"messageIds"`
}

// send POSTs the batch to messaging-svc's internal endpoint with a bounded
// retry. Phase 5's delivered status is a best-effort UX signal, so we retry a
// transient failure a few times (exponential backoff + jitter, total bounded)
// and, on final failure, drop the batch and log — exactly the original
// behavior, just after exhausting the retry budget. A sustained outage trips
// the circuit breaker so subsequent flushes fail-fast instead of each burning
// the full budget. If a single batch is ultimately dropped, the worst case is
// a stuck "Sent" badge until the recipient calls /read (which flips to "Seen").
func (d *Dispatcher) send(ctx context.Context, b *batch) {
	ids := make([]string, 0, len(b.msgIDs))
	for id := range b.msgIDs {
		ids = append(ids, id)
	}
	payload, err := json.Marshal(ackBody{RecipientID: b.recipientID, MessageIDs: ids})
	if err != nil {
		return
	}

	// Fail fast while the breaker is open: messaging-svc is (recently) down,
	// so don't spend httpTimeout*maxAttempts only to drop the batch anyway.
	if d.breakerOpen() {
		d.log.Warn("delivery ack skipped: circuit open", "recipient", b.recipientID, "count", len(ids))
		return
	}

	url := fmt.Sprintf("%s/internal/messages/delivered", d.baseURL)
	reqID := requestIDFromContext(ctx)

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		retryable, err := d.postOnce(ctx, url, payload, reqID)
		if err == nil {
			d.recordSuccess()
			return
		}
		lastErr = err
		// A non-retryable error (e.g. 4xx other than 429, or a malformed
		// request) won't get better by retrying — stop and fall through to the
		// drop-and-log path below.
		if !retryable || attempt == maxAttempts {
			break
		}
		// Backoff before the next attempt. Abort early if the dispatcher's
		// context is cancelled (shutdown) so we don't delay the drain.
		if !sleepCtx(ctx, backoffFor(attempt)) {
			break
		}
	}

	d.recordFailure()
	d.log.Warn("delivery ack POST failed after retries",
		"recipient", b.recipientID, "count", len(ids), "attempts", maxAttempts, "err", lastErr)
}

// postOnce performs a single POST attempt. It returns (retryable, err): err is
// nil on a 2xx; otherwise retryable reports whether a retry could plausibly
// succeed (transport errors, 429, and 5xx are retryable; other 4xx are not).
func (d *Dispatcher) postOnce(ctx context.Context, url string, payload []byte, reqID string) (retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if d.token != "" {
		req.Header.Set("X-Internal-Token", d.token)
	}
	if reqID != "" {
		req.Header.Set("X-Request-Id", reqID)
	}
	resp, err := d.client.Do(req)
	if err != nil {
		// Don't retry once the context is done (shutdown / parent cancel) —
		// there is no point and the drain should finish promptly.
		return ctx.Err() == nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		retry := resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests
		return retry, fmt.Errorf("delivery ack non-2xx: status %d", resp.StatusCode)
	}
	return false, nil
}

// backoffFor returns the sleep before the (attempt+1)th try: exponential on
// backoffBase, capped at backoffMax, with full jitter to avoid a thundering
// herd of dispatchers retrying in lock-step.
func backoffFor(attempt int) time.Duration {
	d := backoffBase << (attempt - 1) // attempt is 1-based
	if d > backoffMax || d <= 0 {     // <=0 guards an unlikely shift overflow
		d = backoffMax
	}
	return time.Duration(rand.Int63n(int64(d) + 1))
}

// sleepCtx sleeps for d unless ctx is cancelled first; it reports whether the
// full sleep elapsed (true) vs. the context being cancelled (false).
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// breakerOpen reports whether the circuit breaker is currently open (fail-fast).
func (d *Dispatcher) breakerOpen() bool {
	d.cbMu.Lock()
	defer d.cbMu.Unlock()
	return !d.cbOpenUntil.IsZero() && time.Now().Before(d.cbOpenUntil)
}

// recordSuccess closes the breaker and resets the failure counter.
func (d *Dispatcher) recordSuccess() {
	d.cbMu.Lock()
	d.cbFailures = 0
	d.cbOpenUntil = time.Time{}
	d.cbMu.Unlock()
}

// recordFailure counts a fully-failed flush and opens the breaker once the
// consecutive-failure threshold is crossed.
func (d *Dispatcher) recordFailure() {
	d.cbMu.Lock()
	d.cbFailures++
	if d.cbFailures >= cbThreshold {
		d.cbOpenUntil = time.Now().Add(cbCooldown)
		// Half-open after the cooldown: reset the counter to threshold-1 so the
		// next single failure re-opens immediately rather than needing a fresh
		// run of cbThreshold failures.
		d.cbFailures = cbThreshold - 1
	}
	d.cbMu.Unlock()
}

// CtxRequestID is the context key under which callers may stash an
// X-Request-Id for the dispatcher to forward onto its outbound POST. Batches
// normally flush from the Run loop's context (which carries no request id), so
// propagation is best-effort: if the key is absent the header is simply
// omitted, exactly as before.
type ctxKey struct{}

// CtxRequestID is the exported context key for the forwarded request id.
var CtxRequestID = ctxKey{}

func requestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(CtxRequestID).(string); ok {
		return v
	}
	return ""
}
