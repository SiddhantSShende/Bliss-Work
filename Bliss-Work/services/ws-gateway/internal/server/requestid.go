package server

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

// HeaderRequestID is the case-insensitive request-id header all services emit.
const HeaderRequestID = "X-Request-Id"

type ctxKey int

const reqIDKey ctxKey = 0

// requestID stamps an X-Request-Id (forwarded by the client or freshly minted)
// on the response and pushes it into the context so handlers can include it
// in logs and the canonical error body.
func requestID(next http.Handler) http.Handler {
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

// requestIDFromContext returns the request id stamped on the request, or "".
func requestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(reqIDKey).(string); ok {
		return v
	}
	return ""
}

// securityHeaders sets the OWASP-recommended response headers. Identical set
// across all Task-Board services. WebSocket upgrade responses get them too —
// browsers ignore most of these on a 101 but a few (HSTS) still apply.
func securityHeaders(next http.Handler) http.Handler {
	headers := map[string]string{
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "strict-origin-when-cross-origin",
		"Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
		"Content-Security-Policy":   "default-src 'none'; frame-ancestors 'none'",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		for k, v := range headers {
			if h.Get(k) == "" {
				h.Set(k, v)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// recoverer is the stdlib-equivalent of chi's middleware.Recoverer — ws-gateway
// uses ServeMux, not chi, so any panic on a non-websocket route would otherwise
// kill the server. We catch, log, and emit a 500 with the canonical body.
func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic recovered",
						"err", rec,
						"path", r.URL.Path,
						"request_id", requestIDFromContext(r.Context()),
					)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"error":{"code":"internal_error","message":"internal error","requestId":"` + requestIDFromContext(r.Context()) + `"}}`))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
