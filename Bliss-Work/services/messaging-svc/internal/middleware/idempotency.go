// Package middleware contains HTTP middleware shared across messaging-svc
// handlers. Today: an Idempotency-Key claim middleware used for the dismiss /
// ignore / read endpoints (no natural client_msg_id like /messages has).
//
// Semantics: claim-once, replay → 204. Handlers gated by this middleware MUST
// be idempotent at the data layer (re-running them with the same input must
// converge to the same state) — the middleware does NOT cache the response
// body. We chose claim-once over body-caching because the gated endpoints all
// return 204 No Content anyway, so there's nothing to cache.
//
// A failed claim (DB unavailable) is a 5xx — DON'T silently skip the
// dedup or two retries can race-execute the same side effect.
//
// A claim only sticks when the handler actually succeeds. If the wrapped
// handler responds with a non-2xx status, the claim is released so a
// legitimate retry with the same key isn't silently dropped on the floor
// (see claimAndServe).
package middleware

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/task-board/messaging-svc/internal/auth"
)

// Idempotency returns a middleware that consumes the Idempotency-Key header.
//
// Behavior matrix:
//
//	Header absent           → pass through (back-compat with callers that
//	                          don't supply the header; the gated endpoints
//	                          are still idempotent at the data layer so this
//	                          is safe).
//	Header present, fresh    → claim + run the handler. A 2xx response keeps
//	                          the claim; a non-2xx response releases it so
//	                          the caller can safely retry the same key.
//	Header present, replay   → respond 204 immediately; do NOT run the handler.
//	DB error on claim        → 500 with internal_error.
//
// The header is scoped to (caller user_id, key) — different users can choose
// the same key without colliding.
func Idempotency(pool *pgxpool.Pool, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("Idempotency-Key")
			if key == "" {
				next.ServeHTTP(w, r)
				return
			}
			if len(key) > 128 {
				http.Error(w, `{"error":"idempotency key too long"}`, http.StatusBadRequest)
				return
			}
			claims, ok := auth.FromContext(r.Context())
			if !ok {
				// Auth middleware MUST run before this; if it didn't, fail closed.
				http.Error(w, `{"error":"missing auth context"}`, http.StatusUnauthorized)
				return
			}
			claimAndServe(w, r, pool, log, claims.UserID, key, next)
		})
	}
}

// claimAndServe claims (userID, key), runs next, and releases the claim again
// if next responds with a non-2xx status — otherwise a handler that fails
// (validation error, downstream 5xx, etc.) would leave the key claimed
// forever, and a legitimate client retry with the same key would be silently
// short-circuited to 204 without the handler ever re-running. A successful
// (2xx) response leaves the claim in place, which is what makes a replay
// short-circuit to 204 in the first place.
func claimAndServe(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, log *slog.Logger, userID, key string, next http.Handler) {
	fresh, err := claimIdempotencyKey(r.Context(), pool, userID, key)
	if err != nil {
		log.Error("idempotency claim failed",
			"user", userID, "key_len", len(key), "err", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if !fresh {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	next.ServeHTTP(rec, r)

	if rec.status < 200 || rec.status >= 300 {
		if releaseErr := releaseIdempotencyKey(r.Context(), pool, userID, key); releaseErr != nil {
			// The handler's own (already-sent) response wins regardless — we
			// only log here, we don't fail the response a second time.
			log.Error("idempotency release failed",
				"user", userID, "key_len", len(key), "status", rec.status, "err", releaseErr)
		}
	}
}

// claimIdempotencyKey inserts a (user_id, key) row. Returns true if newly
// claimed, false if a row already existed (i.e. this is a replay).
func claimIdempotencyKey(ctx context.Context, pool *pgxpool.Pool, userID, key string) (bool, error) {
	if pool == nil {
		return false, errors.New("nil pool")
	}
	ct, err := pool.Exec(ctx,
		`INSERT INTO idempotency_keys (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		userID, key)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}

// releaseIdempotencyKey deletes a claimed (user_id, key) row, symmetric with
// claimIdempotencyKey. Used to undo a claim when the wrapped handler fails,
// so a legitimate retry with the same key isn't silently dropped.
func releaseIdempotencyKey(ctx context.Context, pool *pgxpool.Pool, userID, key string) error {
	if pool == nil {
		return errors.New("nil pool")
	}
	_, err := pool.Exec(ctx,
		`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
		userID, key)
	return err
}
