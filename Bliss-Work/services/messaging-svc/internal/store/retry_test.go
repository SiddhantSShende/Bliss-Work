package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// pgErr is a tiny constructor that returns a *pgconn.PgError that errors.As
// can unwrap — the same shape pgx returns at runtime.
func pgErr(code string) error {
	return &pgconn.PgError{Code: code, Message: "test error"}
}

func TestRetryOnSerializationFailure_succeedsOnSecondAttempt(t *testing.T) {
	calls := 0
	err := RetryOnSerializationFailure(context.Background(), 3, func(ctx context.Context) error {
		calls++
		if calls < 2 {
			return pgErr("40001") // serialization_failure
		}
		return nil
	})
	if err != nil {
		t.Fatalf("got err %v, want nil", err)
	}
	if calls != 2 {
		t.Errorf("called %d times, want 2", calls)
	}
}

func TestRetryOnSerializationFailure_retriesDeadlock(t *testing.T) {
	calls := 0
	err := RetryOnSerializationFailure(context.Background(), 3, func(ctx context.Context) error {
		calls++
		if calls == 1 {
			return pgErr("40P01") // deadlock_detected
		}
		return nil
	})
	if err != nil {
		t.Fatalf("got err %v, want nil", err)
	}
	if calls != 2 {
		t.Errorf("called %d times, want 2", calls)
	}
}

func TestRetryOnSerializationFailure_noRetryOnConstraintViolation(t *testing.T) {
	calls := 0
	err := RetryOnSerializationFailure(context.Background(), 5, func(ctx context.Context) error {
		calls++
		return pgErr("23505") // unique_violation — caller error, never retry
	})
	if err == nil {
		t.Fatal("got nil err, want unique violation")
	}
	if calls != 1 {
		t.Errorf("called %d times, want 1 (no retry on 23505)", calls)
	}
}

func TestRetryOnSerializationFailure_noRetryOnNonPgError(t *testing.T) {
	calls := 0
	err := RetryOnSerializationFailure(context.Background(), 5, func(ctx context.Context) error {
		calls++
		return errors.New("transport failure")
	})
	if err == nil {
		t.Fatal("got nil err, want transport failure")
	}
	if calls != 1 {
		t.Errorf("called %d times, want 1 (no retry on generic errors)", calls)
	}
}

func TestRetryOnSerializationFailure_respectsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already done
	calls := 0
	err := RetryOnSerializationFailure(ctx, 5, func(ctx context.Context) error {
		calls++
		return pgErr("40001")
	})
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
	if calls > 1 {
		t.Errorf("called %d times after ctx cancel; want at most 1", calls)
	}
}

func TestRetryOnSerializationFailure_exhaustsAttempts(t *testing.T) {
	calls := 0
	err := RetryOnSerializationFailure(context.Background(), 3, func(ctx context.Context) error {
		calls++
		return pgErr("40001")
	})
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	if calls != 3 {
		t.Errorf("called %d times, want 3 (maxAttempts)", calls)
	}
}
