// Package jwtauth verifies Bearer JWTs (EdDSA / Ed25519) against a cached
// JWKS and derives the caller identity strictly from the verified claims.
//
// Shared across services that authenticate inbound HTTP requests the same
// way: messaging-svc and notification-svc. ws-gateway verifies tokens for
// WebSocket connections and additionally tracks per-membership presence, so
// it keeps its own Verifier rather than vendoring this package.
package jwtauth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

type ctxKey int

const claimsKey ctxKey = 0

// Claims is the verified caller identity derived from the access token.
type Claims struct {
	UserID   string
	OrgID    string
	Username string
	Roles    []string
}

// Verifier holds a refreshing JWKS cache and validates tokens against it.
type Verifier struct {
	cache   *jwk.Cache
	jwksURL string
	issuer  string
}

// NewVerifier builds a Verifier that fetches and caches the JWKS (~5 min refresh).
func NewVerifier(ctx context.Context, jwksURL, issuer string) (*Verifier, error) {
	cache := jwk.NewCache(ctx)
	if err := cache.Register(jwksURL, jwk.WithMinRefreshInterval(5*time.Minute)); err != nil {
		return nil, err
	}
	// Best-effort warm-up; not fatal if the signer is not up yet.
	_, _ = cache.Refresh(ctx, jwksURL)
	return &Verifier{cache: cache, jwksURL: jwksURL, issuer: issuer}, nil
}

func (v *Verifier) parse(ctx context.Context, raw string) (*Claims, error) {
	set, err := v.cache.Get(ctx, v.jwksURL)
	if err != nil {
		return nil, err
	}
	tok, err := jwt.ParseString(raw,
		jwt.WithKeySet(set),
		jwt.WithValidate(true),
		jwt.WithIssuer(v.issuer),
		jwt.WithAcceptableSkew(30*time.Second),
		jwt.WithRequiredClaim("exp"),
	)
	if err != nil {
		return nil, err
	}
	// jwx treats a zero Unix expiration (exp: 0) the same as "no expiration
	// set" and skips its own expiry check, so WithRequiredClaim alone (which
	// only checks the claim's presence) is not enough: a token with an
	// explicit exp of 0 would otherwise be accepted forever.
	if exp := tok.Expiration(); exp.IsZero() || exp.Unix() == 0 {
		return nil, errors.New("token missing exp claim")
	}

	c := &Claims{UserID: tok.Subject()}
	if org, ok := tok.Get("org_id"); ok {
		c.OrgID, _ = org.(string)
	}
	if un, ok := tok.Get("username"); ok {
		c.Username, _ = un.(string)
	}
	if rs, ok := tok.Get("roles"); ok {
		if arr, ok := rs.([]interface{}); ok {
			for _, r := range arr {
				if s, ok := r.(string); ok {
					c.Roles = append(c.Roles, s)
				}
			}
		}
	}
	if c.UserID == "" || c.OrgID == "" {
		return nil, errors.New("token missing sub/org_id")
	}
	return c, nil
}

// authDiagHeader is the client-supplied (or server-minted — see
// middleware/requestid.go) correlation id, read directly off the request
// rather than through that package, to avoid a shared→service import for
// what is meant to be a short-lived diagnostic.
const authDiagHeader = "X-Request-Id"

// Middleware enforces a valid Bearer token; on success it stores Claims in the context.
// Forged x-org-id / x-user-id headers are never trusted.
//
// TEMPORARY: the slog.Info calls below are diagnostics for the "missing bearer
// token" investigation (messaging channel/reaction/conversation requests
// 401ing while others on the same page succeed) — never log the token itself,
// only whether a well-formed `Bearer ` header arrived. Correlate with the
// matching "authDiag" lines the shared TS ApiClient logs client-side for the
// same X-Request-Id. Remove once root-caused.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		bearerPresent := strings.HasPrefix(authz, "Bearer ")
		if !bearerPresent {
			slog.Info("authdiag",
				"method", r.Method, "path", r.URL.Path,
				"request_id", r.Header.Get(authDiagHeader),
				"bearer_present", false, "status", http.StatusUnauthorized,
			)
			http.Error(w, `{"error":"missing bearer token"}`, http.StatusUnauthorized)
			return
		}
		raw := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
		claims, err := v.parse(r.Context(), raw)
		if err != nil {
			slog.Info("authdiag",
				"method", r.Method, "path", r.URL.Path,
				"request_id", r.Header.Get(authDiagHeader),
				"bearer_present", true, "status", http.StatusUnauthorized, "parse_error", true,
			)
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		// "status" here is deliberately omitted: auth PASSED, but the handler
		// downstream decides the actual response code, which this middleware
		// never sees.
		slog.Info("authdiag",
			"method", r.Method, "path", r.URL.Path,
			"request_id", r.Header.Get(authDiagHeader),
			"bearer_present", true, "auth_result", "ok",
		)
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// FromContext returns the verified claims attached by Middleware.
func FromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
