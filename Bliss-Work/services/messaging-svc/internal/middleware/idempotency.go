// Package middleware contains HTTP middleware shared across messaging-svc
// handlers. Today: an Idempotency-Key claim middleware used for the dismiss /
// ignore / read endpoints (no natural client_msg_id like /messages has).
//
// Semantics: claim, run, record. A claim is bound to the request that made it
// (method + path) and moves from in_progress to done when the handler succeeds,
// storing the status, content type and (small) body it answered with, so a
// replay gets the original answer instead of a bare 204. Handlers gated by this
// middleware MUST still be idempotent at the data layer (re-running them with
// the same input must converge to the same state): a claim whose handler
// crashed is taken over after staleClaimAfter and run again.
//
// A failed claim (DB unavailable) is a 5xx — DON'T silently skip the
// dedup or two retries can race-execute the same side effect.
//
// A claim only sticks when the handler actually succeeds. If the wrapped
// handler responds with a non-2xx status (or panics), the claim is released so
// a legitimate retry with the same key isn't silently dropped on the floor
// (see claimAndServe).
package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/task-board/messaging-svc/internal/auth"
)

const (
	// staleClaimAfter is how long an in_progress claim blocks its key. A claim
	// older than this belongs to a handler that crashed (or was cut off), so the
	// next retry takes it over rather than being refused until the 24h prune.
	staleClaimAfter = 2 * time.Minute

	// maxStoredResponse bounds the response body kept for replays. A larger one
	// is not stored and the replay falls back to a bare 204, as before.
	maxStoredResponse = 64 << 10

	// finalizeTimeout bounds the bookkeeping write after the handler returns. It
	// runs on a context detached from the request so a client that hung up does
	// not leave its claim stuck in_progress.
	finalizeTimeout = 5 * time.Second

	claimAttempts = 3
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
//	                          the claim (and records the response); a non-2xx
//	                          response releases it so the caller can safely
//	                          retry the same key.
//	Header present, replay   → the original's stored response (a bare 204 for
//	                          claims that predate stored responses); do NOT run
//	                          the handler.
//	Replay, original running → 409 with Retry-After; do NOT run the handler.
//	Replay, other request    → 422: the key was used for a different method/path.
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

// claimAndServe claims (userID, key), runs next, then records the outcome: a
// 2xx response marks the claim done (storing the response for replays), anything
// else releases it — otherwise a handler that fails (validation error,
// downstream 5xx, etc.) would leave the key claimed, and a legitimate client
// retry with the same key would be short-circuited without the handler ever
// re-running.
func claimAndServe(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, log *slog.Logger, userID, key string, next http.Handler) {
	route := r.Method + " " + r.URL.Path
	res, err := claimIdempotencyKey(r.Context(), pool, userID, key, route, staleClaimAfter)
	if err != nil {
		log.Error("idempotency claim failed",
			"user", userID, "key_len", len(key), "err", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	switch res.outcome {
	case claimReplay:
		writeReplay(w, res.stored)
		return
	case claimInFlight:
		w.Header().Set("Retry-After", "1")
		writeIdempotencyError(w, r, http.StatusConflict, "conflict",
			"a request with this idempotency key is still being processed")
		return
	case claimOtherRoute:
		writeIdempotencyError(w, r, http.StatusUnprocessableEntity, "validation_error",
			"this idempotency key was already used for a different request")
		return
	}

	// finalized flips once the claim has been marked done or released, so a
	// panicking handler (the recoverer answers 500 above us) still frees the key.
	finalized := false
	defer func() {
		if !finalized {
			rctx, rcancel := context.WithTimeout(context.WithoutCancel(r.Context()), finalizeTimeout)
			defer rcancel()
			if releaseErr := releaseIdempotencyKey(rctx, pool, userID, key); releaseErr != nil {
				log.Error("idempotency release failed",
					"user", userID, "key_len", len(key), "err", releaseErr)
			}
		}
	}()

	rec := &idempotencyRecorder{ResponseWriter: w, status: http.StatusOK}
	next.ServeHTTP(rec, r)

	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), finalizeTimeout)
	defer cancel()
	if rec.status < 200 || rec.status >= 300 {
		finalized = true
		if releaseErr := releaseIdempotencyKey(ctx, pool, userID, key); releaseErr != nil {
			// The handler's own (already-sent) response wins regardless — we
			// only log here, we don't fail the response a second time.
			log.Error("idempotency release failed",
				"user", userID, "key_len", len(key), "status", rec.status, "err", releaseErr)
		}
		return
	}
	finalized = true
	if err := completeIdempotencyKey(ctx, pool, userID, key, route, rec.stored()); err != nil {
		// The key stays in_progress and is taken over after staleClaimAfter;
		// the handler is idempotent at the data layer, so that is safe.
		log.Error("idempotency complete failed",
			"user", userID, "key_len", len(key), "status", rec.status, "err", err)
	}
}

// storedResponse is what a done claim remembers about the original answer.
type storedResponse struct {
	status      int
	contentType string
	body        []byte
}

// idempotencyRecorder tees the handler's response (status always; content type
// and a bounded copy of the body for 2xx) without changing what the client sees.
type idempotencyRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	body        bytes.Buffer
	overflow    bool
}

func (rec *idempotencyRecorder) WriteHeader(code int) {
	if !rec.wroteHeader {
		rec.status = code
		rec.wroteHeader = true
	}
	rec.ResponseWriter.WriteHeader(code)
}

func (rec *idempotencyRecorder) Write(b []byte) (int, error) {
	rec.wroteHeader = true
	if !rec.overflow {
		if rec.body.Len()+len(b) > maxStoredResponse {
			rec.overflow = true
			rec.body.Reset()
		} else {
			rec.body.Write(b)
		}
	}
	return rec.ResponseWriter.Write(b)
}

// stored returns what to remember, or nil when the response is too large to
// keep (the replay then degrades to a bare 204).
func (rec *idempotencyRecorder) stored() *storedResponse {
	if rec.overflow {
		return nil
	}
	return &storedResponse{
		status:      rec.status,
		contentType: rec.Header().Get("Content-Type"),
		body:        rec.body.Bytes(),
	}
}

func writeReplay(w http.ResponseWriter, st *storedResponse) {
	w.Header().Set("Idempotent-Replayed", "true")
	if st == nil || st.status == 0 || st.status == http.StatusNoContent {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if st.contentType != "" {
		w.Header().Set("Content-Type", st.contentType)
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(st.body)))
	w.WriteHeader(st.status)
	_, _ = w.Write(st.body)
}

func writeIdempotencyError(w http.ResponseWriter, r *http.Request, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, err := json.Marshal(rateLimitedBody{Error: rateLimitedPayload{
		Code:      code,
		Message:   msg,
		RequestID: RequestIDFromContext(r.Context()),
	}})
	if err != nil {
		body = []byte(`{"error":{"code":"` + code + `"}}`)
	}
	_, _ = w.Write(body)
}

type claimOutcome int

const (
	claimFresh      claimOutcome = iota // this request owns the key and must run
	claimReplay                         // the original finished 2xx
	claimInFlight                       // the original is still running
	claimOtherRoute                     // the key belongs to a different request
)

type claimResult struct {
	outcome claimOutcome
	stored  *storedResponse // set for claimReplay when a response was recorded
}

// claimIdempotencyKey claims (user_id, key) for route in ONE statement: a new
// row, or the takeover of a stale in_progress row left by the same route. When
// the key is already held it reports why, from the row's own state.
func claimIdempotencyKey(ctx context.Context, pool *pgxpool.Pool, userID, key, route string, staleAfter time.Duration) (claimResult, error) {
	if pool == nil {
		return claimResult{}, errors.New("nil pool")
	}
	for attempt := 0; attempt < claimAttempts; attempt++ {
		var claimed bool
		err := pool.QueryRow(ctx, `
			INSERT INTO idempotency_keys AS k (user_id, key, route, state, updated_at)
			VALUES ($1, $2, $3, 'in_progress', now())
			ON CONFLICT (user_id, key) DO UPDATE
			   SET updated_at = now()
			 WHERE k.state = 'in_progress'
			   AND k.route = EXCLUDED.route
			   AND k.updated_at < now() - make_interval(secs => $4)
			RETURNING true`,
			userID, key, route, staleAfter.Seconds()).Scan(&claimed)
		if err == nil {
			return claimResult{outcome: claimFresh}, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return claimResult{}, err
		}

		var (
			heldRoute, state string
			status           *int32
			ctype            *string
			body             []byte
		)
		err = pool.QueryRow(ctx, `
			SELECT route, state, response_status, response_type, response_body
			  FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
			userID, key).Scan(&heldRoute, &state, &status, &ctype, &body)
		if errors.Is(err, pgx.ErrNoRows) {
			continue // released between our two statements; claim again
		}
		if err != nil {
			return claimResult{}, err
		}
		if heldRoute != "" && heldRoute != route {
			return claimResult{outcome: claimOtherRoute}, nil
		}
		if state == "in_progress" {
			return claimResult{outcome: claimInFlight}, nil
		}
		res := claimResult{outcome: claimReplay}
		if status != nil {
			res.stored = &storedResponse{status: int(*status), body: body}
			if ctype != nil {
				res.stored.contentType = *ctype
			}
		}
		return res, nil
	}
	// The row kept vanishing under us; tell the client to retry shortly.
	return claimResult{outcome: claimInFlight}, nil
}

// completeIdempotencyKey marks a claim done and records the response to replay.
// A nil response stores nothing, so the replay is a bare 204.
func completeIdempotencyKey(ctx context.Context, pool *pgxpool.Pool, userID, key, route string, resp *storedResponse) error {
	if pool == nil {
		return errors.New("nil pool")
	}
	var (
		status *int32
		ctype  *string
		body   []byte
	)
	if resp != nil {
		st := int32(resp.status)
		status = &st
		if resp.contentType != "" {
			ctype = &resp.contentType
		}
		body = resp.body
	}
	_, err := pool.Exec(ctx, `
		UPDATE idempotency_keys
		   SET state = 'done', updated_at = now(),
		       response_status = $4, response_type = $5, response_body = $6
		 WHERE user_id = $1 AND key = $2 AND route = $3 AND state = 'in_progress'`,
		userID, key, route, status, ctype, body)
	return err
}

// releaseIdempotencyKey deletes a claim that never completed, symmetric with
// claimIdempotencyKey. Used to undo a claim when the wrapped handler fails, so
// a legitimate retry with the same key isn't silently dropped. A done claim is
// never touched.
func releaseIdempotencyKey(ctx context.Context, pool *pgxpool.Pool, userID, key string) error {
	if pool == nil {
		return errors.New("nil pool")
	}
	_, err := pool.Exec(ctx,
		`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND state = 'in_progress'`,
		userID, key)
	return err
}
