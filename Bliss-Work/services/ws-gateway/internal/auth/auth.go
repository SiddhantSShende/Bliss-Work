package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// Membership is one organization this person belongs to, and the user id they
// hold in it.
//
// A person has a DIFFERENT users.id per organization — one identity, many
// membership rows — which is why presence needs the pair rather than just an
// org list: the org's online set is keyed by the member id, not by the person.
type Membership struct {
	OrgID  string
	UserID string
}

// Claims holds the verified identity derived from a JWT.
type Claims struct {
	UserID   string
	OrgID    string
	Username string
	Roles    []string
	// Memberships is every active membership this identity holds, from the
	// `memberships` claim. ALWAYS non-empty after Verify: a token minted before
	// the claim existed (or by a path that could not resolve it) falls back to
	// the single current membership, so callers never special-case its absence.
	//
	// Presence metadata, NOT authorization. Nothing here widens what the request
	// may do — the org a request acts in is OrgID alone.
	Memberships []Membership
	Expiry      time.Time
	// SessionID is the refresh-token family this access token was minted
	// alongside (auth-svc's `sid` claim — see app/security/keys.py's
	// mint_access_token). Like Memberships, this is routing/correlation
	// metadata, NOT authorization: it exists so a connection can be matched
	// to the session that opened it and force-closed if that session is
	// revoked (see internal/revoke). Empty for a token minted before this
	// claim existed — such a connection simply cannot be targeted by a
	// session-scoped revoke and is only reached by its own token expiry.
	SessionID string
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

	if sid, ok := parsed.Get("sid"); ok {
		if s, ok := sid.(string); ok {
			claims.SessionID = s
		}
	}

	raw, _ := parsed.Get("memberships")
	claims.Memberships = normalizeMemberships(raw, claims.OrgID, claims.UserID)
	return claims, nil
}

// normalizeMemberships turns the raw `memberships` claim into the list presence
// iterates, and GUARANTEES the caller's current membership is in it.
//
// Split out of Verify so the guarantee is testable without minting a JWT — it is
// the part with the interesting failure modes, and all of them are silent:
//
//   - Claim absent. Tokens minted before it existed stay valid for their full
//     TTL, and must keep behaving exactly as they did: single-org presence.
//   - Claim present but missing the current org. It is a snapshot from mint
//     time, and this is the one membership we know first-hand from a verified
//     `sub` + `org_id`. Presence for THIS session cannot depend on a snapshot.
//   - Malformed entries. Anything half-formed is dropped rather than repaired:
//     an entry with an empty user id would add a blank member to an org's online
//     set, which surfaces as a ghost nobody can account for.
//
// Duplicates are dropped so a claim that already lists the current membership
// does not make presence write it twice.
func normalizeMemberships(raw interface{}, orgID, userID string) []Membership {
	var out []Membership
	seen := map[Membership]bool{}
	add := func(m Membership) {
		if m.OrgID == "" || m.UserID == "" || seen[m] {
			return
		}
		seen[m] = true
		out = append(out, m)
	}

	if arr, ok := raw.([]interface{}); ok {
		for _, m := range arr {
			obj, ok := m.(map[string]interface{})
			if !ok {
				continue
			}
			org, _ := obj["o"].(string)
			usr, _ := obj["u"].(string)
			add(Membership{OrgID: org, UserID: usr})
		}
	}
	add(Membership{OrgID: orgID, UserID: userID})
	return out
}
