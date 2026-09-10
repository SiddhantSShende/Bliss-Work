package store

import (
	"errors"
	"testing"
)

// The three sources a user can pick, and the three names a browser gives them
// back, must land on the same canonical value.
//
// This matters more than a normal input-validation test because the client is
// not expected to translate: MediaTrackSettings.displaySurface is the only
// reliable way to learn what the user actually chose (the picker itself is
// browser chrome the page cannot observe), and it says "monitor" / "window" /
// "browser". A client forwarding that verbatim must not get a 400.
func TestNormalizeShareSourceAcceptsBothSpellings(t *testing.T) {
	cases := map[string]string{
		// The product's own names.
		"screen": ShareScreen,
		"window": ShareWindow,
		"tab":    ShareTab,
		// What a browser reports for the same three choices.
		"monitor": ShareScreen,
		"browser": ShareTab,
		// Case and stray whitespace: these arrive from a JSON body, and
		// rejecting " Window" would be a bug nobody could diagnose from the
		// error message.
		"  SCREEN ": ShareScreen,
		"Window":    ShareWindow,
		"TAB":       ShareTab,
	}
	for in, want := range cases {
		got, err := NormalizeShareSource(in)
		if err != nil {
			t.Errorf("NormalizeShareSource(%q): unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizeShareSource(%q) = %q, want %q", in, got, want)
		}
	}
}

// Anything else is refused. The column has a CHECK constraint, so an
// unrecognised value would otherwise surface as a 500 from a constraint
// violation rather than as the 400 it is.
func TestNormalizeShareSourceRejectsAnythingElse(t *testing.T) {
	for _, in := range []string{"", "   ", "camera", "desktop", "everything", "screen_share"} {
		if got, err := NormalizeShareSource(in); !errors.Is(err, ErrShareSourceInvalid) {
			t.Errorf("NormalizeShareSource(%q) = (%q, %v), want ErrShareSourceInvalid", in, got, err)
		}
	}
}

// A channel owner who is also the call's host turns up in both halves of
// CallStarterIDs' query, and being told twice that somebody is waiting is a
// notification bug rather than a cosmetic one.
func TestDedupeIDsKeepsFirstAndDropsBlanks(t *testing.T) {
	got := dedupeIDs([]string{"a", "b", "a", "", "c", "b", ""})
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("dedupeIDs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("dedupeIDs = %v, want %v (order matters: first occurrence wins)", got, want)
		}
	}
	if out := dedupeIDs(nil); len(out) != 0 {
		t.Errorf("dedupeIDs(nil) = %v, want empty", out)
	}
}
