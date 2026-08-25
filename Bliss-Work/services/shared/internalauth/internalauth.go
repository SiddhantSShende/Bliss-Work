// Package internalauth provides constant-time internal-service-secret
// comparison, shared across this repo's Go services.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Every service that exposes an /internal/* route used to check the caller's
// X-Internal-Token header against a SINGLE shared secret (TB_INTERNAL_TOKEN),
// identical across every service and every caller. Any one compromised
// service — or the deployment env file itself — handed an attacker the same
// credential every other internal endpoint on the platform also trusted. See
// docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2.
//
// Each service now validates against its OWN secret (MESSAGING_INTERNAL_TOKEN,
// WS_GATEWAY_INTERNAL_TOKEN, etc. — one env var per service that exposes an
// /internal/* route), and each caller is configured with only the secrets of
// the services it actually calls. What stays identical across services is the
// comparison itself: constant-time, and fail-CLOSED when the expected secret
// is unconfigured (an empty expected value must never mean "accept
// anything").
//
// The Python services carry the same contract in
// services/shared/internal_auth; this package deliberately returns a bool
// rather than writing an HTTP response, so each caller keeps its own existing
// choice of status code and error body shape — the shared behavior is only
// the comparison.
package internalauth

import "crypto/subtle"

// Matches reports whether provided equals expected, in constant time.
//
// Fails CLOSED: an unconfigured expected (empty string) always returns false
// — never "any caller is accepted" — and an empty provided is likewise
// rejected before the comparison.
func Matches(provided, expected string) bool {
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
