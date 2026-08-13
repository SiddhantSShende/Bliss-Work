package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

type ctxKey string

const claimsKey ctxKey = "claims"

// Claims are the verified identity derived from the JWT. These MUST come from a
// cryptographically verified token — never from request headers.
type Claims struct {
	UserID   string
	OrgID    string
	Username string
	Roles    []string
}

// Verifier validates Bearer tokens against a cached JWKS.
type Verifier struct {
	cache   *jwk.Cache
	jwksURL string
	issuer  string
}

// NewVerifier creates a Verifier and registers the JWKS URL with a ~5 min
// refresh interval.
func NewVerifier(ctx context.Context, jwksURL, issuer string) (*Verifier, error) {
	cache := jwk.NewCache(ctx)
	if err := cache.Register(jwksURL, jwk.WithMinRefreshInterval(5*60*1e9)); err != nil {
		return nil, err
	}
	// Warm the cache; ignore errors so the service can start before auth-svc is
	// fully ready — verification will retry on first request.
	_, _ = cache.Refresh(ctx, jwksURL)
	return &Verifier{cache: cache, jwksURL: jwksURL, issuer: issuer}, nil
}

// parse verifies a raw token string and returns the derived claims.
func (v *Verifier) parse(ctx context.Context, raw string) (*Claims, error) {
	set, err := v.cache.Get(ctx, v.jwksURL)
	if err != nil {
		return nil, err
	}

	tok, err := jwt.ParseString(raw,
		jwt.WithKeySet(set),
		jwt.WithValidate(true),
		jwt.WithIssuer(v.issuer),
		jwt.WithAcceptableSkew(30*1e9),
	)
	if err != nil {
		return nil, err
	}

	claims := &Claims{UserID: tok.Subject()}

	if org, ok := tok.Get("org_id"); ok {
		if s, ok := org.(string); ok {
			claims.OrgID = s
		}
	}
	if un, ok := tok.Get("username"); ok {
		if s, ok := un.(string); ok {
			claims.Username = s
		}
	}
	if rs, ok := tok.Get("roles"); ok {
		if arr, ok := rs.([]interface{}); ok {
			for _, r := range arr {
				if s, ok := r.(string); ok {
					claims.Roles = append(claims.Roles, s)
				}
			}
		}
	}

	if claims.UserID == "" || claims.OrgID == "" {
		return nil, errors.New("token missing required claims")
	}
	return claims, nil
}

// Middleware enforces a valid Bearer token and injects Claims into the context.
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

// FromContext extracts verified Claims set by Middleware.
func FromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
