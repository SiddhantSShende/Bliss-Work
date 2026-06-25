// security.go: OWASP-recommended response headers, identical across Go and
// FastAPI services. Browsers honour these even on JSON API responses.
package middleware

import "net/http"

// SecurityHeaderSet is the canonical header set every Task-Board service emits.
//
// CSP `default-src 'none'; frame-ancestors 'none'` is safe for an API: there
// is no first-party UI hosted off these routes, so anything the browser tries
// to load from the JSON body would be a misconfiguration anyway. The Vite/CDN
// origin sets its own CSP for the SPA.
var SecurityHeaderSet = map[string]string{
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options":    "nosniff",
	"X-Frame-Options":           "DENY",
	"Referrer-Policy":           "strict-origin-when-cross-origin",
	"Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
	"Content-Security-Policy":   "default-src 'none'; frame-ancestors 'none'",
}

// SecurityHeaders sets the canonical security headers on every response.
// Uses setdefault semantics (only writes if not already present) so handlers
// can override a specific header when needed (rare).
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		for k, v := range SecurityHeaderSet {
			if h.Get(k) == "" {
				h.Set(k, v)
			}
		}
		next.ServeHTTP(w, r)
	})
}
