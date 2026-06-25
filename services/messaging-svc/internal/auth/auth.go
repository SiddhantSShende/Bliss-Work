// Package auth verifies Bearer JWTs (EdDSA / Ed25519) against a cached JWKS and
// derives the caller identity strictly from the verified claims.
package auth

import (
	"context"
	"errors"
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
	)
	if err != nil {
		return nil, err
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

// Middleware enforces a valid Bearer token; on success it stores Claims in the context.
// Forged x-org-id / x-user-id headers are never trusted.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			http.Error(w, `{"error":"missing bearer token"}`, http.StatusUnauthorized)
			return
		}
		raw := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
		claims, err := v.parse(r.Context(), raw)
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// FromContext returns the verified claims attached by Middleware.
func FromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
