// Package middleware contains messaging-svc HTTP middlewares.
//
// requestid.go: every request gets an X-Request-Id (forwarded by the client or
// freshly minted), stamped into the response header and accessible via
// RequestIDFromContext so handlers and the logger can include it. This is the
// single string a customer needs to send to support for us to pin a trace.
package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

type ctxKey int

const reqIDKey ctxKey = 0

// Header name we both read and echo.
const HeaderRequestID = "X-Request-Id"

// RequestID returns chi-compatible middleware that ensures every request has an
// X-Request-Id, echoes it on the response, and pushes it into the context.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get(HeaderRequestID)
		if rid == "" || len(rid) > 128 {
			rid = uuid.NewString()
		}
		w.Header().Set(HeaderRequestID, rid)
		ctx := context.WithValue(r.Context(), reqIDKey, rid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequestIDFromContext returns the request id stamped on the request, or "".
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(reqIDKey).(string); ok {
		return v
	}
	return ""
}
