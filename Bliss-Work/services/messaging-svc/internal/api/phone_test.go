package api

import (
	"strings"
	"testing"
)

// The vectors here are deliberately mirrored in packages/app/src/lib/phone.test.ts.
// The two normalizers are separate implementations (Go is authoritative, the TS one
// exists so the UI can disable a submit button); the shared table is what stops
// them drifting apart unnoticed.
func TestNormalizeE164(t *testing.T) {
	ok := []struct {
		name, in, want string
	}{
		{"the spec's own example", "+1 (555) 019-2834", "15550192834"},
		{"already normalized", "15550192834", "15550192834"},
		{"00 international prefix", "0044 20 7946 0958", "442079460958"},
		{"plus international prefix", "+44 20 7946 0958", "442079460958"},
		{"single leading zero", "015550192834", "15550192834"},
		{"dots and dashes", "1.555.019.2834", "15550192834"},
		{"non-breaking space and unicode dash", "+1 555‑0192834", "15550192834"},
		{"maximum length", strings.Repeat("9", 15), strings.Repeat("9", 15)},
		{"minimum length", strings.Repeat("9", 8), strings.Repeat("9", 8)},
	}
	for _, tc := range ok {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeE164(tc.in)
			if err != nil {
				t.Fatalf("normalizeE164(%q) returned error %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("normalizeE164(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}

	bad := []struct{ name, in string }{
		{"empty", ""},
		{"letters only", "call me"},
		{"punctuation only", "+()- "},
		{"too short", "1234567"},
		{"too long", strings.Repeat("9", 16)},
		{"all zeroes reduces to nothing", "0000000000"},
		{"local number without country code", "0192834"},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := normalizeE164(tc.in); err == nil {
				t.Fatalf("normalizeE164(%q) = %q, want an error", tc.in, got)
			}
		})
	}
}

func TestSanitizeContactName(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"plain", "Jane Doe", "Jane Doe"},
		{"trims", "  Jane Doe  ", "Jane Doe"},
		{"collapses runs of whitespace", "Jane\t\t  Doe", "Jane Doe"},
		{"drops newlines that would break the pill", "Jane\nDoe", "JaneDoe"},
		{"drops control characters", "Jane\x00\x07Doe", "JaneDoe"},
		{"empty stays empty", "   ", ""},
		{"non-latin survives", "ヤマダ タロウ", "ヤマダ タロウ"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeContactName(tc.in); got != tc.want {
				t.Fatalf("sanitizeContactName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}

	t.Run("caps at maxContactNameRunes counting runes not bytes", func(t *testing.T) {
		// Every rune here is 3 bytes, so a byte-based cap would truncate to a
		// third of the intended length (and could split a rune in half).
		got := sanitizeContactName(strings.Repeat("あ", maxContactNameRunes+10))
		if n := len([]rune(got)); n != maxContactNameRunes {
			t.Fatalf("got %d runes, want %d", n, maxContactNameRunes)
		}
	})
}
