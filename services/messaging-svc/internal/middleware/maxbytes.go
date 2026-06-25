package middleware

import "net/http"

// MaxBytes caps the request body size for every route it wraps. A client that
// streams more than n bytes has its read terminated by http.MaxBytesReader, so
// handlers that json.Decode the body fail fast with a 400 instead of buffering
// an unbounded payload into the heap (a cheap DoS otherwise). GET/HEAD requests
// carry no body, so this is a no-op for reads. Apply once at the router root.
func MaxBytes(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, n)
			}
			next.ServeHTTP(w, r)
		})
	}
}
