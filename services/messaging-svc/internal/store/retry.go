// retry.go: small helper for retrying Postgres transactions that bounce off
// a serialization conflict (40001) or a deadlock (40P01).
//
// These errors are *transient* — the same transaction will usually succeed on
// the second attempt because the conflicting tx has now committed. Retrying
// once with a tiny jitter is the canonical recipe and keeps the call site
// readable: callers don't have to wrap every Begin/Commit in retry logic.
//
// We deliberately do NOT retry on:
//   - Constraint violations (23xxx): the caller's data is wrong, retrying
//     won't help.
//   - Unique violations (23505): same — and writes are idempotent server-side
//     via the idempotency middleware, so retrying could produce duplicates.
//   - Connection errors (08xxx): handled by pgxpool's retry loop already.
package store

import (
	"context"
	"errors"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// RetryOnSerializationFailure runs fn up to maxAttempts times. Sleeps for a
// small jittered delay between attempts so the second attempt doesn't race
// the conflicting tx at the same instant.
func RetryOnSerializationFailure(ctx context.Context, maxAttempts int, fn func(context.Context) error) error {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			// 25-75ms jittered backoff, growing slightly with each retry.
			delay := time.Duration(25+rand.Intn(50)+attempt*25) * time.Millisecond
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		err := fn(ctx)
		if err == nil {
			return nil
		}
		if !isRetryable(err) {
			return err
		}
		lastErr = err
	}
	return lastErr
}

// isRetryable returns true for Postgres errors that the caller's transaction
// can resolve by simply re-running.
func isRetryable(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.Code {
	case "40001": // serialization_failure
		return true
	case "40P01": // deadlock_detected
		return true
	}
	return false
}
