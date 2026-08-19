// Package media holds the two pieces of attachment handling that are pure
// functions of their input — download-URL signing and MIME disposition — so
// both can be exhaustively unit-tested without a database or an HTTP server.
package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ── Why signed URLs instead of the Bearer token ──────────────────────────────
//
// auth.Verifier.Middleware requires an `Authorization: Bearer` header. A browser
// CANNOT set one on <img src> or <video src> — those are plain subresource GETs.
// The alternatives were:
//
//   * fetch() the bytes and hand the client a blob: URL. Works, but buffers the
//     whole file into renderer memory before the first frame paints and throws
//     away HTTP Range, so a 100 MB video cannot be scrubbed and cannot start
//     playing until it has fully downloaded.
//   * a cookie. The API is reached cross-origin from the desktop app, and a
//     media-scoped cookie is ambient authority on every request to the origin.
//
// So: a short-lived HMAC token in the query string. It binds attachmentID, orgID
// AND userID, which is what lets the download handler re-check membership as the
// granted user, and means a leaked link is useless to anyone else once it
// expires. The token authenticates; the handler still authorizes.

// ErrInvalidToken covers every rejection reason. Callers must not distinguish
// them to the client: "expired" vs "forged" vs "malformed" is free information
// for an attacker probing the format.
var ErrInvalidToken = errors.New("media: invalid token")

// minSecretLen is enforced at construction. The signer is effectively a
// universal read primitive for every attachment in every org, so a short or
// defaulted secret is not a degraded mode — it is a total compromise.
const minSecretLen = 32

// Grant is the authorization a token carries. Field names are single letters
// because the encoded payload rides in a URL that appears in HTML attributes.
type Grant struct {
	AttachmentID string    `json:"a"`
	OrgID        string    `json:"o"`
	UserID       string    `json:"u"`
	Exp          time.Time `json:"-"`
	// Kind names WHAT the id refers to, and exists so one signer can serve two
	// resources without either link working on the other's route. Empty means
	// an attachment — the only thing this signed before recordings existed, so
	// tokens minted then keep verifying and keep meaning what they meant.
	//
	// Handlers must check it. The ids are distinct UUID spaces, so a swap is
	// not exploitable today; the check is what keeps that from being a fact the
	// next resource silently depends on.
	Kind string `json:"k,omitempty"`
}

// Resource kinds. KindAttachment is the empty default and is never written.
const (
	KindAttachment = ""
	KindRecording  = "r"
)

// wire is the on-the-wire shape: Exp as a Unix second, which keeps the payload
// short and avoids RFC3339 parsing differences round-tripping a time.Time.
type wire struct {
	A string `json:"a"`
	O string `json:"o"`
	U string `json:"u"`
	E int64  `json:"e"`
	K string `json:"k,omitempty"`
}

// Signer mints and verifies media download tokens.
type Signer struct {
	secret []byte
}

// NewSigner fails closed on a missing or too-short secret.
func NewSigner(secret string) (*Signer, error) {
	if len(secret) < minSecretLen {
		return nil, fmt.Errorf("media: signing secret must be at least %d bytes", minSecretLen)
	}
	return &Signer{secret: []byte(secret)}, nil
}

var b64 = base64.RawURLEncoding

// Sign returns "<payload>.<mac>", both base64url without padding so the token is
// safe unescaped in a query string.
func (s *Signer) Sign(g Grant) string {
	payload, _ := json.Marshal(
		wire{A: g.AttachmentID, O: g.OrgID, U: g.UserID, E: g.Exp.Unix(), K: g.Kind})
	enc := b64.EncodeToString(payload)
	return enc + "." + b64.EncodeToString(s.mac(enc))
}

// Verify authenticates a token and returns the grant it carries.
//
// Order matters: the MAC is checked BEFORE the payload is parsed, so unverified
// attacker-controlled bytes never reach the JSON decoder. Expiry is checked last
// because it is the only check that can pass for a forgery.
func (s *Signer) Verify(tok string) (*Grant, error) {
	encPayload, encMAC, ok := strings.Cut(tok, ".")
	if !ok || encPayload == "" || encMAC == "" {
		return nil, ErrInvalidToken
	}
	gotMAC, err := b64.DecodeString(encMAC)
	if err != nil {
		return nil, ErrInvalidToken
	}
	if !hmac.Equal(gotMAC, s.mac(encPayload)) {
		return nil, ErrInvalidToken
	}

	raw, err := b64.DecodeString(encPayload)
	if err != nil {
		return nil, ErrInvalidToken
	}
	var w wire
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, ErrInvalidToken
	}
	if w.A == "" || w.O == "" || w.U == "" {
		return nil, ErrInvalidToken
	}
	exp := time.Unix(w.E, 0)
	if time.Now().After(exp) {
		return nil, ErrInvalidToken
	}
	return &Grant{AttachmentID: w.A, OrgID: w.O, UserID: w.U, Exp: exp, Kind: w.K}, nil
}

func (s *Signer) mac(encPayload string) []byte {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(encPayload))
	return m.Sum(nil)
}
