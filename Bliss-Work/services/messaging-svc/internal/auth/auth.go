// Package auth verifies Bearer JWTs (EdDSA / Ed25519) against a cached JWKS and
// derives the caller identity strictly from the verified claims.
//
// Thin re-export of shared-jwtauth so every existing call site in this
// service (auth.Claims, auth.Verifier, auth.FromContext, ...) keeps working
// unchanged while the verification logic itself lives in one place shared
// with notification-svc.
package auth

import jwtauth "github.com/task-board/shared-jwtauth"

// Claims is the verified caller identity derived from the access token.
type Claims = jwtauth.Claims

// Verifier holds a refreshing JWKS cache and validates tokens against it.
type Verifier = jwtauth.Verifier

// NewVerifier builds a Verifier that fetches and caches the JWKS (~5 min refresh).
var NewVerifier = jwtauth.NewVerifier

// FromContext returns the verified claims attached by Verifier.Middleware.
var FromContext = jwtauth.FromContext
