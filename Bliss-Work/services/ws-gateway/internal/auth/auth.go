package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// Claims holds the verified identity derived from a JWT.
type Claims struct {
	UserID   string
	OrgID    string
	Username string
	Roles    []string
	Expiry   time.Time
}

// Verifier validates EdDSA JWTs against a cached JWKS.
type Verifier struct {
	cache  *jwk.Cache
	url    string
	issuer string
}

// NewVerifier builds a Verifier that fetches the JWKS at jwksURL and refreshes
// it roughly every 5 minutes.
func NewVerifier(ctx context.Context, jwksURL, issuer string) (*Verifier, error) {
	cache := jwk.NewCache(ctx)
	if err := cache.Register(jwksURL, jwk.WithMinRefreshInterval(5*time.Minute)); err != nil {
		return nil, fmt.Errorf("register jwks: %w", err)
	}
	// Best-effort warm-up; do not fail startup if auth-svc is not yet ready.
	_, _ = cache.Refresh(ctx, jwksURL)
	return &Verifier{cache: cache, url: jwksURL, issuer: issuer}, nil
}

// Verify parses and validates a Bearer token, returning the derived claims.
func (v *Verifier) Verify(ctx context.Context, token string) (*Claims, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, errors.New("empty token")
	}

	set, err := v.cache.Get(ctx, v.url)
	if err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}

	parsed, err := jwt.ParseString(
		token,
		jwt.WithKeySet(set),
		jwt.WithValidate(true),
		jwt.WithIssuer(v.issuer),
		jwt.WithAcceptableSkew(30*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("parse/verify token: %w", err)
	}

	claims := &Claims{
		UserID: parsed.Subject(),
		Expiry: parsed.Expiration(),
	}

	if org, ok := parsed.Get("org_id"); ok {
		if s, ok := org.(string); ok {
			claims.OrgID = s
		}
	}
	if uname, ok := parsed.Get("username"); ok {
		if s, ok := uname.(string); ok {
			claims.Username = s
		}
	}
	if rolesRaw, ok := parsed.Get("roles"); ok {
		if arr, ok := rolesRaw.([]interface{}); ok {
			for _, r := range arr {
				if s, ok := r.(string); ok {
					claims.Roles = append(claims.Roles, s)
				}
			}
		}
	}

	if claims.UserID == "" || claims.OrgID == "" {
		return nil, errors.New("token missing sub/org_id")
	}
	return claims, nil
}

// AlgEdDSA is exported so callers can assert the expected signing algorithm.
var AlgEdDSA = jwa.EdDSA
