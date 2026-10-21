package server

import (
	"bytes"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/push"
)

// signedPushTestServer builds a Server with both the legacy shared token AND
// a configured set of push-signing verify keys, so tests can exercise the
// cryptographic path handlePush now prefers. Mirrors pushTestServer in
// push_test.go, which this file deliberately does not modify.
func signedPushTestServer(token string, keys map[string]ed25519.PublicKey) *Server {
	return &Server{
		cfg:            Config{WSGatewayInternalToken: token},
		hub:            hub.New(),
		pushVerifyKeys: keys,
	}
}

func doSignedPush(t *testing.T, s *Server, token, forgedCallerHeader, jwtStr string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, push.Path, bytes.NewReader(body))
	if token != "" {
		req.Header.Set(push.TokenHeader, token)
	}
	if forgedCallerHeader != "" {
		req.Header.Set(push.CallerHeader, forgedCallerHeader)
	}
	if jwtStr != "" {
		req.Header.Set(push.PushJWTHeader, jwtStr)
	}
	rec := httptest.NewRecorder()
	s.handlePush(rec, req)
	return rec
}

// mustSignedToken builds a valid push JWT for role, signed by priv — the same
// push.MintPushJWT call push.Client.SendTo makes internally for a signed
// client, exercised directly here so these tests don't need a live HTTP
// round-trip on the client side.
func mustSignedToken(t *testing.T, role string, priv ed25519.PrivateKey) string {
	t.Helper()
	tok, err := push.MintPushJWT(role, priv)
	if err != nil {
		t.Fatalf("mint jwt: %v", err)
	}
	return tok
}

// mustExpiredToken and mustWrongAudienceToken build tokens that are
// correctly SIGNED by priv but otherwise invalid, to prove handlePush
// validates more than just the signature.
func mustExpiredToken(t *testing.T, priv ed25519.PrivateKey) string {
	t.Helper()
	tok, err := jwt.NewBuilder().
		Issuer("ws-gateway").
		Audience([]string{"ws-gateway-internal-push"}).
		Subject(push.CallerDeliverySvc).
		IssuedAt(time.Now().Add(-2 * time.Minute)).
		Expiration(time.Now().Add(-1 * time.Minute)).
		Build()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, priv))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return string(signed)
}

func mustWrongAudienceToken(t *testing.T, priv ed25519.PrivateKey) string {
	t.Helper()
	tok, err := jwt.NewBuilder().
		Issuer("ws-gateway").
		Audience([]string{"some-other-endpoint"}).
		Subject(push.CallerDeliverySvc).
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(30 * time.Second)).
		Build()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, priv))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return string(signed)
}

// 1. A caller presenting a valid signed credential for its real role, doing
// the batch shape that role is entitled to, succeeds — and a forged
// X-Internal-Caller header sent alongside it is ignored, not trusted.
func TestHandlePush_ValidSignedDeliverySvcCallerSucceeds(t *testing.T) {
	pub, priv := genTestKeypair(t)
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerDeliverySvc: pub})
	tok := mustSignedToken(t, push.CallerDeliverySvc, priv)

	// Forged header claims to be the gateway peer; the verified JWT says
	// delivery-svc, and delivery-svc is entitled to post Deliveries.
	rec := doSignedPush(t, s, "supersecret", push.CallerGatewayPeer, tok, deliveriesBody(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestHandlePush_ValidSignedGatewayPeerCallerSucceeds(t *testing.T) {
	pub, priv := genTestKeypair(t)
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerGatewayPeer: pub})
	tok := mustSignedToken(t, push.CallerGatewayPeer, priv)

	rec := doSignedPush(t, s, "supersecret", "", tok, broadcastBody(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

// 2. A forged X-Internal-Caller header cannot be used to escalate: a
// delivery-svc-signed token trying to post a Broadcast (the gateway-peer-only
// shape) is rejected even though the header claims to be a gateway peer.
func TestHandlePush_ForgedCallerHeaderCannotEscalateRole(t *testing.T) {
	pub, priv := genTestKeypair(t)
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerDeliverySvc: pub})
	tok := mustSignedToken(t, push.CallerDeliverySvc, priv)

	rec := doSignedPush(t, s, "supersecret", push.CallerGatewayPeer, tok, broadcastBody(t))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("delivery-svc-signed token posting Broadcast despite a gateway-peer header claim: got %d, want 403", rec.Code)
	}
}

// 3. Missing or invalid JWT credential: once the header is present at all,
// a bad value is rejected outright — it must NOT fall back to the legacy
// header path, even if that header is itself valid.
func TestHandlePush_InvalidSignedCredentialRejectedNoFallback(t *testing.T) {
	pub, _ := genTestKeypair(t)
	_, otherPriv := genTestKeypair(t) // not in the server's key set
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerDeliverySvc: pub})

	badTok := mustSignedToken(t, push.CallerDeliverySvc, otherPriv)
	rec := doSignedPush(t, s, "supersecret", push.CallerDeliverySvc, badTok, deliveriesBody(t))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unverifiable signed credential: got %d, want 401 (must not fall back to the legacy, otherwise-valid header)", rec.Code)
	}

	rec = doSignedPush(t, s, "supersecret", push.CallerDeliverySvc, "not-a-jwt-at-all", deliveriesBody(t))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("malformed jwt header: got %d, want 401", rec.Code)
	}
}

// 4. Expired / wrong-audience credentials fail closed, even against a server
// that has the right key configured.
func TestHandlePush_ExpiredOrWrongAudienceCredentialRejected(t *testing.T) {
	pub, priv := genTestKeypair(t)
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerDeliverySvc: pub})

	expired := mustExpiredToken(t, priv)
	rec := doSignedPush(t, s, "supersecret", push.CallerDeliverySvc, expired, deliveriesBody(t))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired token: got %d, want 401", rec.Code)
	}

	wrongAud := mustWrongAudienceToken(t, priv)
	rec = doSignedPush(t, s, "supersecret", push.CallerDeliverySvc, wrongAud, deliveriesBody(t))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-audience token: got %d, want 401", rec.Code)
	}
}

// 5. A valid identity attempting an operation outside its role's allowed
// batch shape is still rejected under the signed path, same as the
// pre-existing header-only enforcement (push_test.go's
// TestHandlePush_WrongRoleForBatchShapeRejected) — this just proves that
// guard is unaffected by which identity mechanism supplied the role.
func TestHandlePush_SignedValidRoleWrongBatchShapeRejected(t *testing.T) {
	pub, priv := genTestKeypair(t)
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerGatewayPeer: pub})
	tok := mustSignedToken(t, push.CallerGatewayPeer, priv)

	rec := doSignedPush(t, s, "supersecret", "", tok, deliveriesBody(t))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("gateway-peer signed identity posting Deliveries: got %d, want 403", rec.Code)
	}
}

// 6. Auth-dependency failure: if the server has no verify key configured for
// ANY role (e.g. the deploy has not provisioned keys yet, or a role's key
// was unparseable at startup) and a caller presents a JWT anyway, the
// request fails closed rather than silently trusting the header.
func TestHandlePush_NoVerifyKeysConfiguredFailsClosedForSignedCaller(t *testing.T) {
	_, priv := genTestKeypair(t)
	s := signedPushTestServer("supersecret", nil) // no verify keys at all
	tok := mustSignedToken(t, push.CallerDeliverySvc, priv)

	rec := doSignedPush(t, s, "supersecret", push.CallerDeliverySvc, tok, deliveriesBody(t))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401 when the server has no verify keys and a JWT was presented", rec.Code)
	}
}

// 7. The legacy shared-token+header path is kept for migration and still
// works for a caller that presents no JWT at all — this is the explicit,
// clearly-marked-deprecated fallback, exercised end to end once more here to
// confirm it survives alongside the new code path (push_test.go already
// covers it in isolation).
func TestHandlePush_LegacyHeaderPathStillWorksWhenNoJWTPresented(t *testing.T) {
	pub, _ := genTestKeypair(t)
	// Server HAS a verify key configured for delivery-svc, but this request
	// sends no JWT header at all, so it must take the legacy path and
	// succeed on the header alone — configuring crypto for one role must not
	// break callers of the other role that have not been migrated yet.
	s := signedPushTestServer("supersecret", map[string]ed25519.PublicKey{push.CallerDeliverySvc: pub})

	rec := doSignedPush(t, s, "supersecret", push.CallerGatewayPeer, "", broadcastBody(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("un-migrated gateway-peer caller via legacy header: got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func genTestKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}
