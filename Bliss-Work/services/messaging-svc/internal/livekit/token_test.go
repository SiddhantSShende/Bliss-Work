package livekit

import (
	"strings"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

const testSecret = "0123456789abcdef0123456789abcdef" // exactly 32

func mustMinter(t *testing.T) *Minter {
	t.Helper()
	m, err := New("APIkey", testSecret, "wss://sfu.example.com", MinterOptions{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m
}

// A token IS the authorization to publish into a room, so the failure mode of
// a misconfigured minter must be "refuse", never "issue something weak".
func TestNewRejectsPartialAndWeakConfig(t *testing.T) {
	cases := []struct {
		name             string
		key, secret, url string
		wantErr          bool
		wantConfigured   bool
	}{
		{"all empty is a valid disabled state", "", "", "", false, false},
		{"fully configured", "k", testSecret, "wss://x", false, true},
		{"key without secret", "k", "", "wss://x", true, false},
		{"secret without url", "k", testSecret, "", true, false},
		{"url only", "", "", "wss://x", true, false},
		{"short secret", "k", "tooshort", "wss://x", true, false},
		{"31-char secret is still short", "k", strings.Repeat("a", 31), "wss://x", true, false},
		{"32-char secret is accepted", "k", strings.Repeat("a", 32), "wss://x", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, err := New(tc.key, tc.secret, tc.url, MinterOptions{})
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error, got none — a half-configured SFU must fail at boot")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if m.Configured() != tc.wantConfigured {
				t.Errorf("Configured() = %v, want %v", m.Configured(), tc.wantConfigured)
			}
		})
	}
}

// An unconfigured minter must refuse loudly rather than return an empty token,
// which would surface as an unexplained media failure in the browser.
func TestUnconfiguredMinterRefuses(t *testing.T) {
	var m Minter
	if _, _, err := m.Mint(Grant{Room: "r", Identity: "u"}); err != ErrNotConfigured {
		t.Fatalf("got %v, want ErrNotConfigured", err)
	}
}

func TestMintRequiresRoomAndIdentity(t *testing.T) {
	m := mustMinter(t)
	if _, _, err := m.Mint(Grant{Identity: "u"}); err == nil {
		t.Error("a token with no room would grant access to whichever room the client names")
	}
	if _, _, err := m.Mint(Grant{Room: "r"}); err == nil {
		t.Error("a token with no identity would join as an anonymous participant")
	}
}

// The claim shape is a contract with LiveKit's server-side parser. If these
// names drift the token still signs and verifies, and then silently grants
// nothing — so assert them explicitly.
func TestMintProducesTheExpectedGrant(t *testing.T) {
	m := mustMinter(t)
	signed, exp, err := m.Mint(Grant{
		Room:       "call-123",
		Identity:   "user-abc",
		Name:       "Ada",
		CanPublish: true,
		RoomAdmin:  true,
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if !exp.After(time.Now().UTC()) {
		t.Fatal("token already expired at mint time")
	}

	tok, err := jwt.Parse([]byte(signed), jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("token does not verify with the API secret: %v", err)
	}
	if tok.Issuer() != "APIkey" {
		t.Errorf("iss = %q, want the API key", tok.Issuer())
	}
	if tok.Subject() != "user-abc" {
		t.Errorf("sub = %q, want the user id — LiveKit reads identity from sub", tok.Subject())
	}

	raw, ok := tok.Get("video")
	if !ok {
		t.Fatal("no `video` claim; LiveKit grants nothing without it")
	}
	v, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("`video` claim is %T, want an object", raw)
	}
	if v["room"] != "call-123" {
		t.Errorf("room = %v, want call-123", v["room"])
	}
	for _, k := range []string{"roomJoin", "canPublish", "canSubscribe", "roomAdmin"} {
		if v[k] != true {
			t.Errorf("%s = %v, want true", k, v[k])
		}
	}
}

// A participant who may not publish must still be able to watch, and must NOT
// carry roomAdmin — that is the difference between a guest and a host.
func TestMintListenerGrantCannotPublishOrAdminister(t *testing.T) {
	m := mustMinter(t)
	signed, _, err := m.Mint(Grant{Room: "r", Identity: "u", CanPublish: false, RoomAdmin: false})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	tok, err := jwt.Parse([]byte(signed), jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	raw, _ := tok.Get("video")
	v := raw.(map[string]any)
	if v["canPublish"] != false {
		t.Error("canPublish must be false for a listener")
	}
	if v["canSubscribe"] != true {
		t.Error("a listener must still be able to watch")
	}
	// omitempty means an absent key is the correct representation of false.
	if adm, present := v["roomAdmin"]; present && adm != false {
		t.Errorf("roomAdmin = %v, want absent or false", adm)
	}
}

// A token signed with a different secret must not verify — the whole security
// model rests on the secret staying server-side.
func TestTokenDoesNotVerifyWithTheWrongSecret(t *testing.T) {
	m := mustMinter(t)
	signed, _, err := m.Mint(Grant{Room: "r", Identity: "u", CanPublish: true})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if _, err := jwt.Parse([]byte(signed), jwt.WithKey(jwa.HS256, []byte(strings.Repeat("z", 32)))); err == nil {
		t.Fatal("token verified under the wrong secret")
	}
}

// Short-lived by design: every refresh re-checks database access, which is what
// makes removal from a channel actually end someone's call.
func TestDefaultTTLIsShort(t *testing.T) {
	m := mustMinter(t)
	_, exp, err := m.Mint(Grant{Room: "r", Identity: "u"})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if d := time.Until(exp); d > time.Hour {
		t.Errorf("default TTL is %v; a long-lived room token outlives the access check behind it", d)
	}
	_, exp2, err := m.Mint(Grant{Room: "r", Identity: "u", TTL: 2 * time.Minute})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if d := time.Until(exp2); d > 3*time.Minute {
		t.Errorf("explicit TTL ignored: %v", d)
	}
}

// sourcesOf pulls canPublishSources out of a minted token's video grant.
// Absent is reported separately from empty, because to LiveKit those two mean
// opposite things — see the tests below.
func sourcesOf(t *testing.T, m *Minter, g Grant) (any, bool) {
	t.Helper()
	signed, _, err := m.Mint(g)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	tok, err := jwt.Parse([]byte(signed), jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	raw, _ := tok.Get("video")
	v, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("`video` claim is %T, want an object", raw)
	}
	src, present := v["canPublishSources"]
	return src, present
}

// asStrings flattens the JSON array the claim round-trips as.
func asStrings(t *testing.T, v any) []string {
	t.Helper()
	list, ok := v.([]any)
	if !ok {
		t.Fatalf("canPublishSources is %T, want an array", v)
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, ok := e.(string)
		if !ok {
			t.Fatalf("source entry is %T, want a string", e)
		}
		out = append(out, s)
	}
	return out
}

func hasSource(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// Screen sharing has to be a capability that can be WITHHELD, not one implied
// by being allowed to publish at all. LiveKit reads an ABSENT canPublishSources
// as "any source", so a grant that leaves the field off silently permits screen
// sharing — which is exactly the bug this asserts against.
func TestScreenShareIsAnExplicitCapability(t *testing.T) {
	m := mustMinter(t)

	withShare, present := sourcesOf(t, m, Grant{
		Room: "r", Identity: "u", CanPublish: true, CanShareScreen: true,
	})
	if !present {
		t.Fatal("canPublishSources absent; LiveKit reads that as 'any source', so the grant is unbounded")
	}
	got := asStrings(t, withShare)
	for _, want := range []string{"camera", "microphone", "screen_share", "screen_share_audio"} {
		if !hasSource(got, want) {
			t.Errorf("source %q missing from %v", want, got)
		}
	}

	// The same grant WITHOUT screen sharing must still name its sources — the
	// field being present is what bounds it — and must name neither
	// screen-share source.
	noShare, present := sourcesOf(t, m, Grant{
		Room: "r", Identity: "u", CanPublish: true, CanShareScreen: false,
	})
	if !present {
		t.Fatal("canPublishSources absent when screen sharing is withheld; the withholding does nothing")
	}
	got = asStrings(t, noShare)
	for _, banned := range []string{"screen_share", "screen_share_audio"} {
		if hasSource(got, banned) {
			t.Errorf("source %q granted despite CanShareScreen=false: %v", banned, got)
		}
	}
	if !hasSource(got, "camera") || !hasSource(got, "microphone") {
		t.Errorf("camera/microphone lost along with screen share: %v", got)
	}
}

// A listener publishes nothing, so the source list is meaningless for them and
// must be OMITTED rather than sent empty — an empty list reads as "unrestricted"
// to LiveKit, which would be precisely backwards.
func TestListenerCarriesNoSourceList(t *testing.T) {
	m := mustMinter(t)
	// CanShareScreen is set here to prove it is ignored without CanPublish.
	_, present := sourcesOf(t, m, Grant{
		Room: "r", Identity: "u", CanPublish: false, CanShareScreen: true,
	})
	if present {
		t.Error("a listener carries canPublishSources; canPublish=false is what stops them, " +
			"and an empty list would read as 'any source'")
	}
}
