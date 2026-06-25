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
//	Header absent          → pass through (back-compat with callers that don't
//	                         supply the header; the gated endpoints are still
//	                         idempotent at the data layer so this is safe).
//	Header present, fresh  → claim + pass through.
//	Header present, replay → respond 204 immediately; do NOT run the handler.
//	DB error on claim      → 500 with internal_error.
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
			fresh, err := claimIdempotencyKey(r.Context(), pool, claims.UserID, key)
			if err != nil {
				log.Error("idempotency claim failed",
					"user", claims.UserID, "key_len", len(key), "err", err)
				http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
				return
			}
			if !fresh {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
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
