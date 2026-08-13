package media

import (
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef" // exactly 32 bytes

func newTestSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner(testSecret)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return s
}

// A weak or defaulted secret is a universal read primitive over every
// attachment in every org, so construction must refuse it.
func TestNewSigner_RejectsShortSecret(t *testing.T) {
	for _, s := range []string{"", "short", strings.Repeat("x", 31)} {
		if _, err := NewSigner(s); err == nil {
			t.Errorf("NewSigner(%d bytes) accepted a too-short secret", len(s))
		}
	}
	if _, err := NewSigner(strings.Repeat("x", 32)); err != nil {
		t.Errorf("NewSigner rejected a 32-byte secret: %v", err)
	}
}

func TestSignVerify_RoundTrip(t *testing.T) {
	s := newTestSigner(t)
	want := Grant{
		AttachmentID: "018f0000-0000-7000-8000-000000000001",
		OrgID:        "018f0000-0000-7000-8000-0000000000aa",
		UserID:       "018f0000-0000-7000-8000-0000000000bb",
		Exp:          time.Now().Add(10 * time.Minute),
	}
	got, err := s.Verify(s.Sign(want))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.AttachmentID != want.AttachmentID || got.OrgID != want.OrgID || got.UserID != want.UserID {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

// Every field is inside the MAC. Flipping any one of them must invalidate the
// token — otherwise a user could retarget their own link at another org's
// attachment, or at another user to dodge the membership re-check.
func TestVerify_TamperedFieldsRejected(t *testing.T) {
	s := newTestSigner(t)
	base := Grant{
		AttachmentID: "018f0000-0000-7000-8000-000000000001",
		OrgID:        "018f0000-0000-7000-8000-0000000000aa",
		UserID:       "018f0000-0000-7000-8000-0000000000bb",
		Exp:          time.Now().Add(10 * time.Minute),
	}
	tok := s.Sign(base)
	payload, mac, _ := strings.Cut(tok, ".")

	mutations := map[string]Grant{
		"attachment": {AttachmentID: "018f0000-0000-7000-8000-0000000000ff", OrgID: base.OrgID, UserID: base.UserID, Exp: base.Exp},
		"org":        {AttachmentID: base.AttachmentID, OrgID: "018f0000-0000-7000-8000-0000000000ff", UserID: base.UserID, Exp: base.Exp},
		"user":       {AttachmentID: base.AttachmentID, OrgID: base.OrgID, UserID: "018f0000-0000-7000-8000-0000000000ff", Exp: base.Exp},
		"exp":        {AttachmentID: base.AttachmentID, OrgID: base.OrgID, UserID: base.UserID, Exp: base.Exp.Add(24 * time.Hour)},
	}
	for name, m := range mutations {
		// Swap in the mutated payload but keep the ORIGINAL mac.
		forged, _, _ := strings.Cut(s.Sign(m), ".")
		if _, err := s.Verify(forged + "." + mac); err == nil {
			t.Errorf("tampering with %s was accepted", name)
		}
	}
	// Sanity: the untouched token still verifies.
	if _, err := s.Verify(payload + "." + mac); err != nil {
		t.Fatalf("unmodified token rejected: %v", err)
	}
}

func TestVerify_ExpiredRejected(t *testing.T) {
	s := newTestSigner(t)
	tok := s.Sign(Grant{
		AttachmentID: "a", OrgID: "o", UserID: "u",
		Exp: time.Now().Add(-time.Second),
	})
	if _, err := s.Verify(tok); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestVerify_WrongSecretRejected(t *testing.T) {
	a := newTestSigner(t)
	b, err := NewSigner("ffffffffffffffffffffffffffffffff")
	if err != nil {
		t.Fatal(err)
	}
	tok := a.Sign(Grant{AttachmentID: "a", OrgID: "o", UserID: "u", Exp: time.Now().Add(time.Minute)})
	if _, err := b.Verify(tok); err == nil {
		t.Fatal("token verified under a different secret")
	}
}

// Malformed input reaches Verify constantly (truncated URLs, crawlers). It must
// return an error, never panic — and must not decode the payload before the MAC
// has been checked.
func TestVerify_MalformedInputDoesNotPanic(t *testing.T) {
	s := newTestSigner(t)
	for _, tok := range []string{
		"", ".", "..", "no-dot", "a.b", "....", strings.Repeat("A", 10000),
		"!!!.???", ".onlymac", "onlypayload.", "\x00.\x00",
	} {
		if _, err := s.Verify(tok); err == nil {
			t.Errorf("Verify(%q) unexpectedly succeeded", tok)
		}
	}
}

// The signature covers only the payload segment, so an empty/absent payload
// must not be treated as a valid empty grant.
func TestVerify_EmptyGrantFieldsRejected(t *testing.T) {
	s := newTestSigner(t)
	tok := s.Sign(Grant{AttachmentID: "", OrgID: "", UserID: "", Exp: time.Now().Add(time.Minute)})
	if _, err := s.Verify(tok); err == nil {
		t.Fatal("grant with empty ids accepted")
	}
}
