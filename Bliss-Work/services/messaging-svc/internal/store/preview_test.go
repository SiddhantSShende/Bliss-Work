package store

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Structured message bodies (file offers, media attachments, shared locations)
// are "readable prefix + U+001F + JSON". Only the prefix may reach an inbox
// preview — the raw envelope leaking into the list pane was a live bug before
// the sentinel-aware cut.
func TestTruncatePreview_StopsAtEnvelopeSentinel(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{
			"media envelope",
			"🖼️ 3 photos" + string(envelopeSentinel) + `{"v":2,"kind":"media","items":[{"id":"018f0000-0000-7000-8000-000000000001"}]}`,
			"🖼️ 3 photos",
		},
		{
			"location envelope",
			"📍 Office" + string(envelopeSentinel) + `{"v":2,"kind":"location","lat":12.9716,"lng":77.5946}`,
			"📍 Office",
		},
		{
			"legacy v1 file offer",
			"📎 report.pdf · 2.1 MB" + string(envelopeSentinel) + `{"v":1,"offerId":"abc","sha256":"deadbeef"}`,
			"📎 report.pdf · 2.1 MB",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := truncatePreview(c.body)
			if got != c.want {
				t.Errorf("truncatePreview() = %q, want %q", got, c.want)
			}
			if strings.ContainsRune(got, envelopeSentinel) {
				t.Error("preview still contains the sentinel")
			}
			if strings.Contains(got, `"v":`) {
				t.Error("preview leaked envelope JSON")
			}
		})
	}
}

// previewLen is a byte budget and the readable prefixes begin with multi-byte
// emoji, so a naive clean[:previewLen] can slice a rune in half. The invalid
// UTF-8 then survives encryption and returns as U+FFFD.
func TestTruncatePreview_NeverSplitsARune(t *testing.T) {
	// Every offset lands mid-rune for at least some of these lengths.
	for n := 1; n <= 120; n++ {
		body := strings.Repeat("🖼", n)
		got := truncatePreview(body)
		if !utf8.ValidString(got) {
			t.Fatalf("n=%d produced invalid UTF-8: %q", n, got)
		}
		if strings.ContainsRune(got, utf8.RuneError) {
			t.Fatalf("n=%d produced a replacement char: %q", n, got)
		}
		if len(got) > previewLen {
			t.Fatalf("n=%d exceeded the byte budget: %d", n, len(got))
		}
	}

	// Mixed-width text truncated at the boundary.
	mixed := "héllo wörld " + strings.Repeat("é", 100)
	got := truncatePreview(mixed)
	if !utf8.ValidString(got) || len(got) > previewLen {
		t.Fatalf("mixed-width truncation invalid: len=%d valid=%v", len(got), utf8.ValidString(got))
	}
}

func TestTruncatePreview_CollapsesWhitespace(t *testing.T) {
	if got := truncatePreview("hello\r\n\n  world\t\tagain"); got != "hello world again" {
		t.Errorf("got %q", got)
	}
	if got := truncatePreview(""); got != "" {
		t.Errorf("empty body -> %q", got)
	}
}

// A body that is nothing but an envelope (no readable prefix) must yield an
// empty preview rather than raw JSON.
func TestTruncatePreview_EnvelopeOnlyBody(t *testing.T) {
	if got := truncatePreview(string(envelopeSentinel) + `{"v":2,"kind":"media"}`); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}
