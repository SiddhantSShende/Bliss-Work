package push

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// ── Why this exists ──────────────────────────────────────────────────────────
// Batch 2 (see batch-2-push-auth-fix.md) scoped what an authenticated /internal/push
// caller may DO by role, but the role itself came from X-Internal-Caller, a
// plain header the caller sets on its own request — a claim, not a credential.
// Anyone holding WS_GATEWAY_INTERNAL_TOKEN (necessarily true of both legitimate
// callers, and of anything that compromises either of them) could already set
// that header to either value; nothing cryptographically bound it to who was
// actually on the other end of the connection.
//
// This file adds a second, independent factor: a short-lived JWT, signed with
// an Ed25519 key that only ONE role's deployment ever holds, verified against
// that role's public key. The role returned by VerifyPushJWT is the public key
// that verified the signature — never a claim carried inside the token — so a
// caller that holds only delivery-svc's private key cannot mint a token that
// verifies as ws-gateway-peer merely by writing a different `sub`.
//
// ── Why Ed25519 JWTs signed locally, and not the existing JWKS verifier ─────
// internal/auth.Verifier already does exactly this kind of verification, but
// for a different credential: USER access tokens, minted by auth-svc, fetched
// from auth-svc's JWKS over the network. Reusing it here would make every
// gateway-to-gateway push and every delivery-svc push depend on auth-svc being
// reachable — a new runtime dependency this endpoint has never had, for two
// callers that are not users and that auth-svc has no concept of minting
// service credentials for today (confirmed: no service-account/internal-JWT
// minting path exists anywhere in auth-svc's codebase). Standing one up would
// be new infrastructure, which the task explicitly treats as a blocker
// requiring approval rather than something to improvise.
//
// What this does instead costs nothing new: the jwx/v2 library is already a
// dependency of this exact module (internal/auth imports it), Ed25519
// keypairs need no CA or external service, and delivery-svc / the gateway
// peer binaries are built and deployed from this same module already (see
// push.go's module-boundary doc comment) — so a signing key configured on one
// side and a verify key configured on the other is the same deployment
// mechanism (one more env var per process) already used for
// WS_GATEWAY_INTERNAL_TOKEN, not a new system.
//
// ── Migration posture ────────────────────────────────────────────────────────
// Provisioning real keys to delivery-svc / every gateway node in prod is a
// deployment change this pass cannot make (no touching .env.prod or deploying
// anything). So this is additive: when a process has no signing/verify keys
// configured, it falls back to exactly Batch 2's existing shared-token +
// header behaviour, which keeps working unchanged. When keys ARE configured,
// the signed path is authoritative and the header becomes informational only
// — see internal/server/push.go's handlePush for exactly how the two compose.

// PushJWTHeader carries the signed credential, independent of CallerHeader.
const PushJWTHeader = "X-Internal-Push-JWT" //nolint:gosec // G101: header name, not a credential

// pushJWTAudience scopes these tokens to this one endpoint, so a credential
// minted for some other internal purpose (now or in the future) cannot be
// replayed here, and vice versa.
const pushJWTAudience = "ws-gateway-internal-push"

// pushJWTTTL is deliberately short: this token is minted fresh for every
// outbound push (see Client.SendTo), never cached, so there is no benefit to
// a longer window — only a larger replay-if-intercepted blast radius.
const pushJWTTTL = 30 * time.Second

// ParseEd25519PrivateKey decodes a base64 (standard, unpadded-or-padded, both
// accepted) 32-byte Ed25519 seed, as produced by ed25519.GenerateKey and
// stored in e.g. WS_GATEWAY_PUSH_SIGNING_KEY.
func ParseEd25519PrivateKey(b64 string) (ed25519.PrivateKey, error) {
	raw, err := decodeKeyB64(b64)
	if err != nil {
		return nil, fmt.Errorf("push: decode signing key: %w", err)
	}
	switch len(raw) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(raw), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(raw), nil
	default:
		return nil, fmt.Errorf("push: signing key must be %d or %d bytes, got %d", ed25519.SeedSize, ed25519.PrivateKeySize, len(raw))
	}
}

// ParseEd25519PublicKey decodes a base64 32-byte Ed25519 public key, as
// produced by ed25519.GenerateKey (or derived from the seed held by the
// matching signer) and stored in e.g. WS_GATEWAY_PUSH_VERIFY_KEY_DELIVERY_SVC.
func ParseEd25519PublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := decodeKeyB64(b64)
	if err != nil {
		return nil, fmt.Errorf("push: decode verify key: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("push: verify key must be %d bytes, got %d", ed25519.PublicKeySize, len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

func decodeKeyB64(b64 string) ([]byte, error) {
	if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
		return raw, nil
	}
	return base64.RawStdEncoding.DecodeString(b64)
}

// MintPushJWT builds and signs a short-lived credential asserting role,
// signed by priv. The `sub` claim is informational only (useful in logs to
// see what a caller THINKS it is) — the authoritative role, on the verifying
// side, is whichever public key validated the signature, never this claim.
//
// Exported so tests in other packages (e.g. internal/server's handlePush
// tests) can mint credentials directly without going through a live HTTP
// round-trip; Client.SendTo is the only production caller.
func MintPushJWT(role string, priv ed25519.PrivateKey) (string, error) {
	now := time.Now()
	tok, err := jwt.NewBuilder().
		Issuer("ws-gateway").
		Audience([]string{pushJWTAudience}).
		Subject(role).
		IssuedAt(now).
		Expiration(now.Add(pushJWTTTL)).
		Build()
	if err != nil {
		return "", fmt.Errorf("push: build jwt: %w", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, priv))
	if err != nil {
		return "", fmt.Errorf("push: sign jwt: %w", err)
	}
	return string(signed), nil
}

// VerifyPushJWT checks token's signature against each candidate key in turn
// and returns the role name of whichever one verified it.
//
// This is the cryptographic source of truth for caller identity: the
// returned role is never read out of the token's own claims, only out of
// which caller's public key the signature matches — so a forged `sub` inside
// a token signed with role A's key is simply a token that still, correctly,
// identifies as A.
//
// Fails closed: an empty token, an empty key set, a signature that matches no
// configured key, an expired token, or a wrong-audience/issuer token all
// return an error and no role.
func VerifyPushJWT(token string, keys map[string]ed25519.PublicKey) (string, error) {
	if token == "" {
		return "", errors.New("push: empty jwt")
	}
	if len(keys) == 0 {
		return "", errors.New("push: no verify keys configured")
	}
	var lastErr error = errors.New("push: signature did not match any configured key")
	for role, pub := range keys {
		parsed, err := jwt.Parse(
			[]byte(token),
			jwt.WithKey(jwa.EdDSA, pub),
			jwt.WithValidate(true),
			jwt.WithIssuer("ws-gateway"),
			jwt.WithAudience(pushJWTAudience),
			jwt.WithAcceptableSkew(5*time.Second),
		)
		if err != nil {
			// Wrong key for this token (or truly invalid) — try the next
			// candidate rather than failing on the first mismatch.
			lastErr = err
			continue
		}
		_ = parsed
		return role, nil
	}
	return "", fmt.Errorf("push: jwt verification failed: %w", lastErr)
}
