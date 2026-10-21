package push

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

func genKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}

// A token signed by one role's key verifies as that role, never as whatever
// `sub` claim it happens to carry — the central property this file exists to
// test.
func TestVerifyPushJWT_RoleComesFromKeyNotClaim(t *testing.T) {
	pubDelivery, privDelivery := genKeypair(t)
	pubPeer, _ := genKeypair(t)
	keys := map[string]ed25519.PublicKey{
		CallerDeliverySvc: pubDelivery,
		CallerGatewayPeer: pubPeer,
	}

	// Forged sub: this token is signed with delivery-svc's key but claims to
	// be the gateway peer in its own `sub` field.
	tok, err := jwt.NewBuilder().
		Issuer("ws-gateway").
		Audience([]string{pushJWTAudience}).
		Subject(CallerGatewayPeer). // forged
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(pushJWTTTL)).
		Build()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, privDelivery))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	role, err := VerifyPushJWT(string(signed), keys)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if role != CallerDeliverySvc {
		t.Fatalf("got role %q, want %q (the key that signed it, not the forged sub claim)", role, CallerDeliverySvc)
	}
}

// mintPushJWT/VerifyPushJWT round-trip for a legitimately minted token.
func TestMintAndVerifyPushJWT_RoundTrip(t *testing.T) {
	pub, priv := genKeypair(t)
	tok, err := MintPushJWT(CallerGatewayPeer, priv)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	role, err := VerifyPushJWT(tok, map[string]ed25519.PublicKey{CallerGatewayPeer: pub})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if role != CallerGatewayPeer {
		t.Fatalf("got %q, want %q", role, CallerGatewayPeer)
	}
}

// A token signed by a key not in the configured set verifies against nothing.
func TestVerifyPushJWT_UnknownSignerRejected(t *testing.T) {
	_, privUnknown := genKeypair(t)
	pubKnown, _ := genKeypair(t)
	tok, err := MintPushJWT(CallerDeliverySvc, privUnknown)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, err := VerifyPushJWT(tok, map[string]ed25519.PublicKey{CallerDeliverySvc: pubKnown}); err == nil {
		t.Fatal("expected verification failure for a signer outside the configured key set")
	}
}

// Expired tokens are rejected.
func TestVerifyPushJWT_ExpiredRejected(t *testing.T) {
	pub, priv := genKeypair(t)
	tok, err := jwt.NewBuilder().
		Issuer("ws-gateway").
		Audience([]string{pushJWTAudience}).
		Subject(CallerDeliverySvc).
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
	if _, err := VerifyPushJWT(string(signed), map[string]ed25519.PublicKey{CallerDeliverySvc: pub}); err == nil {
		t.Fatal("expected expired token to be rejected")
	}
}

// Wrong audience is rejected even with a signature that otherwise verifies.
func TestVerifyPushJWT_WrongAudienceRejected(t *testing.T) {
	pub, priv := genKeypair(t)
	tok, err := jwt.NewBuilder().
		Issuer("ws-gateway").
		Audience([]string{"some-other-endpoint"}).
		Subject(CallerDeliverySvc).
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(pushJWTTTL)).
		Build()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, priv))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := VerifyPushJWT(string(signed), map[string]ed25519.PublicKey{CallerDeliverySvc: pub}); err == nil {
		t.Fatal("expected wrong-audience token to be rejected")
	}
}

// Missing credential (empty token) and missing dependency (no verify keys
// configured at all) both fail closed.
func TestVerifyPushJWT_MissingCredentialOrKeysFailsClosed(t *testing.T) {
	pub, _ := genKeypair(t)
	if _, err := VerifyPushJWT("", map[string]ed25519.PublicKey{CallerDeliverySvc: pub}); err == nil {
		t.Fatal("expected empty token to be rejected")
	}
	priv := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	tok, err := MintPushJWT(CallerDeliverySvc, priv)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, err := VerifyPushJWT(tok, nil); err == nil {
		t.Fatal("expected verification with no configured keys at all to fail closed")
	}
}

// ParseEd25519PrivateKey/PublicKey round-trip base64 seeds and reject garbage.
func TestParseEd25519Keys(t *testing.T) {
	pub, priv := genKeypair(t)
	seed := priv.Seed()
	b64 := b64Encode(seed)
	parsedPriv, err := ParseEd25519PrivateKey(b64)
	if err != nil {
		t.Fatalf("parse priv: %v", err)
	}
	if !parsedPriv.Public().(ed25519.PublicKey).Equal(pub) {
		t.Fatal("parsed private key does not match the original keypair's public key")
	}

	pubB64 := b64Encode(pub)
	parsedPub, err := ParseEd25519PublicKey(pubB64)
	if err != nil {
		t.Fatalf("parse pub: %v", err)
	}
	if !parsedPub.Equal(pub) {
		t.Fatal("parsed public key mismatch")
	}

	if _, err := ParseEd25519PrivateKey("not-valid-base64!!"); err == nil {
		t.Fatal("expected garbage input to fail to parse")
	}
	if _, err := ParseEd25519PublicKey(b64Encode([]byte("too-short"))); err == nil {
		t.Fatal("expected wrong-length key to fail to parse")
	}
}

func b64Encode(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}
