package media

import (
	"strings"
	"testing"
)

// The single most important property in this package: a script-capable document
// is NEVER served inline, no matter how it was stored. If this test fails, an
// org member can take over their colleagues' accounts by uploading an "image".
func TestServeAs_ScriptableTypesAreNeverInline(t *testing.T) {
	dangerous := []string{
		"image/svg+xml",
		"text/html",
		"application/xhtml+xml",
		"text/xml",
		"application/xml",
		"application/javascript",
		"text/javascript",
		"image/svg+xml; charset=utf-8",
		"IMAGE/SVG+XML",
		"text/html;charset=windows-1252",
	}
	for _, d := range dangerous {
		ct, inline := ServeAs(d)
		if inline {
			t.Errorf("ServeAs(%q) returned inline=true; scriptable types must be forced to attachment", d)
		}
		if ct != "application/octet-stream" {
			t.Errorf("ServeAs(%q) content-type = %q; want application/octet-stream so the type itself is also inert", d, ct)
		}
	}
}

func TestServeAs_AllowlistedTypesAreInline(t *testing.T) {
	for _, ok := range []string{"image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg", "application/pdf", "text/plain"} {
		ct, inline := ServeAs(ok)
		if !inline || ct != ok {
			t.Errorf("ServeAs(%q) = (%q,%v); want (%q,true)", ok, ct, inline, ok)
		}
	}
}

func TestServeAs_UnknownIsDownloaded(t *testing.T) {
	for _, u := range []string{"", "application/x-msdownload", "image/heic", "application/zip", "garbage"} {
		ct, inline := ServeAs(u)
		if inline || ct != "application/octet-stream" {
			t.Errorf("ServeAs(%q) = (%q,%v); want (application/octet-stream,false)", u, ct, inline)
		}
	}
}

// A client declaring image/png over HTML bytes is the core attack. The sniff
// must win.
func TestSniff_ServerSniffBeatsDeclaredType(t *testing.T) {
	html := []byte("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>")
	got := Sniff(html, "image/png", "cat.png")
	if _, inline := ServeAs(got); inline {
		t.Fatalf("Sniff of HTML bytes declared as image/png yielded %q which serves inline", got)
	}
}

func TestSniff_SVGDeclaredAsImageIsNotInlined(t *testing.T) {
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`)
	got := Sniff(svg, "image/png", "logo.png")
	if _, inline := ServeAs(got); inline {
		t.Fatalf("SVG bytes yielded %q which serves inline", got)
	}
}

func TestSniff_RealFormats(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	if got := Sniff(png, "application/octet-stream", "x.png"); got != "image/png" {
		t.Errorf("png sniff = %q", got)
	}

	jpeg := append([]byte("\xff\xd8\xff\xe0"), make([]byte, 64)...)
	if got := Sniff(jpeg, "", "x.jpg"); got != "image/jpeg" {
		t.Errorf("jpeg sniff = %q", got)
	}

	webp := []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")
	if got := Sniff(webp, "", "x.webp"); got != "image/webp" {
		t.Errorf("webp sniff = %q", got)
	}

	avif := []byte("\x00\x00\x00\x20ftypavif\x00\x00\x00\x00")
	if got := Sniff(avif, "", "x.avif"); got != "image/avif" {
		t.Errorf("avif sniff = %q", got)
	}

	mp4 := []byte("\x00\x00\x00\x20ftypisom\x00\x00\x00\x00")
	if got := Sniff(mp4, "", "x.mp4"); got != "video/mp4" {
		t.Errorf("mp4 sniff = %q", got)
	}
}

// An unrecognised blob must not be upgraded by a client claim to a type we
// would then render.
func TestSniff_DeclaredCannotWidenBeyondAllowlist(t *testing.T) {
	blob := make([]byte, 64) // sniffs as octet-stream
	if got := Sniff(blob, "image/svg+xml", "x.svg"); got == "image/svg+xml" {
		t.Fatal("declared svg was accepted for opaque bytes")
	}
	if got := Sniff(blob, "text/html", "x.html"); got == "text/html" {
		t.Fatal("declared html was accepted for opaque bytes")
	}
}

func TestSanitizeFilename(t *testing.T) {
	cases := []struct{ in, want string }{
		{"../../etc/passwd", "passwd"},
		{`..\..\windows\system32\cmd.exe`, "cmd.exe"},
		{"/etc/shadow", "shadow"},
		{"report.pdf", "report.pdf"},
		{"..", "file"},
		{"", "file"},
		{"   ", "file"},
		{"a\x00b.txt", "ab.txt"},
		{"inject\r\nX-Evil: 1", "injectX-Evil: 1"},
		{"a\tb.txt", "ab.txt"},
		{"файл.pdf", "файл.pdf"},
	}
	for _, c := range cases {
		if got := SanitizeFilename(c.in); got != c.want {
			t.Errorf("SanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeFilename_TruncatesOnRuneBoundary(t *testing.T) {
	long := strings.Repeat("é", 300) // 600 bytes
	got := SanitizeFilename(long)
	if len(got) > maxFilenameBytes {
		t.Errorf("len = %d, want <= %d", len(got), maxFilenameBytes)
	}
	if !isValidUTF8(got) {
		t.Error("truncation split a rune")
	}
}

// A filename must never be able to inject a second header or break out of the
// quoted string.
func TestContentDisposition_NoHeaderInjection(t *testing.T) {
	got := ContentDisposition(false, "evil\r\nSet-Cookie: a=b\".pdf")
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("header value contains CR/LF: %q", got)
	}
	// Exactly two quotes: the ones wrapping the ASCII fallback.
	if strings.Count(got, `"`) != 2 {
		t.Fatalf("unbalanced quoting, filename escaped its quotes: %q", got)
	}
	if !strings.HasPrefix(got, "attachment; ") {
		t.Fatalf("want attachment disposition, got %q", got)
	}
}

func TestContentDisposition_InlineAndUnicode(t *testing.T) {
	got := ContentDisposition(true, "файл.pdf")
	if !strings.HasPrefix(got, "inline; ") {
		t.Fatalf("want inline, got %q", got)
	}
	if !strings.Contains(got, "filename*=UTF-8''") {
		t.Fatalf("missing RFC 5987 form: %q", got)
	}
	if strings.Contains(got, "файл") && !strings.Contains(got, "%D1%84") {
		t.Fatalf("unicode not percent-encoded in filename*: %q", got)
	}
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == 0xFFFD {
			return false
		}
	}
	return true
}
