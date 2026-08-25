// Package auth verifies Bearer JWTs (EdDSA / Ed25519) against a cached JWKS and
// derives the caller identity strictly from the verified claims. These
// claims MUST come from a cryptographically verified token — never from
// request headers.
//
// Thin re-export of shared-jwtauth so every existing call site in this
// service (auth.Claims, auth.Verifier, auth.FromContext, ...) keeps working
// unchanged while the verification logic itself lives in one place shared
// with messaging-svc.
package auth

import jwtauth "github.com/task-board/shared-jwtauth"

// Claims are the verified identity derived from the JWT.
type Claims = jwtauth.Claims

// Verifier validates Bearer tokens against a cached JWKS.
type Verifier = jwtauth.Verifier

// NewVerifier creates a Verifier and registers the JWKS URL with a ~5 min
// refresh interval.
var NewVerifier = jwtauth.NewVerifier

// FromContext extracts verified Claims set by Verifier.Middleware.
var FromContext = jwtauth.FromContext
