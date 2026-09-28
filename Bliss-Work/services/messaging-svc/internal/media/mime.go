package media

import (
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY-CRITICAL. This file decides what a browser does with bytes an
// arbitrary org member uploaded, served from OUR OWN ORIGIN.
//
// The threat is stored XSS escalating to full account takeover: an SVG or an
// HTML file is a script document. Served inline from the app's origin it runs
// with the app's origin — same-origin fetch against every API, access to
// anything the session can reach. It does not matter that the uploader had to
// be authenticated; a single compromised or malicious org member would own
// every colleague who clicked their "image".
//
// The mitigation is an ALLOWLIST, not a denylist, in ServeAs: a type is served
// inline only if it is explicitly known to be inert. Everything else — every
// unknown type, every future type, anything script-shaped — is downgraded to
// application/octet-stream and forced to `attachment`, which browsers download
// rather than render.
//
// Do not "just add" a type here. See mime_test.go.
// ─────────────────────────────────────────────────────────────────────────────

// inlineTypes is the closed set of types safe to render in place. Each entry is
// a passive media format with no scripting surface. Notably ABSENT and never to
// be added: image/svg+xml, text/html, application/xhtml+xml, text/xml,
// application/xml — all of these can execute script.
var inlineTypes = map[string]bool{
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/avif":      true,
	"video/mp4":       true,
	"video/webm":      true,
	"video/quicktime": true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"audio/wav":       true,
	"audio/webm":      true,
	"application/pdf": true,
	"text/plain":      true,
}

// Sniff decides the type we STORE for an upload.
//
// The server's own content sniff always wins. A client's declared Content-Type
// is an unauthenticated assertion — the whole attack is "declare image/png,
// upload HTML" — so `declared` is consulted only to refine a sniff that came
// back as the generic application/octet-stream, and even then only if it names
// an inline-safe type. The filename extension is the last and weakest resort,
// used for formats http.DetectContentType predates (webp/avif) or cannot see.
func Sniff(head []byte, declared, filename string) string {
	sniffed := normalizeType(http.DetectContentType(head))

	// A confident sniff is authoritative.
	if sniffed != "application/octet-stream" && sniffed != "text/plain" {
		return sniffed
	}

	// http.DetectContentType has no signature for these; the magic bytes are
	// unambiguous, so read them directly rather than trusting the client.
	if t := sniffExtra(head); t != "" {
		return t
	}

	// Generic sniff: accept the client's claim only when it names a type we
	// would serve inline anyway, so a lie can never widen what we do.
	if d := normalizeType(declared); inlineTypes[d] {
		return d
	}

	// Extension, same restriction.
	if ext := strings.ToLower(filepath.Ext(filename)); ext != "" {
		if t := normalizeType(mime.TypeByExtension(ext)); inlineTypes[t] {
			return t
		}
	}

	if sniffed == "text/plain" {
		return "text/plain"
	}
	return "application/octet-stream"
}

// sniffExtra covers container formats the stdlib sniffer misses.
func sniffExtra(head []byte) string {
	// RIFF....WEBP
	if len(head) >= 12 && string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP" {
		return "image/webp"
	}
	// ISO-BMFF: ....ftyp<brand>. Distinguishes avif/heic from mp4/mov.
	if len(head) >= 12 && string(head[4:8]) == "ftyp" {
		switch strings.ToLower(string(head[8:12])) {
		case "avif", "avis":
			return "image/avif"
		case "heic", "heix", "hevc", "mif1", "msf1":
			// Stored honestly. ServeAs will not inline it (no browser support is
			// guaranteed), so it downloads — which is the correct behaviour.
			return "image/heic"
		case "qt  ":
			return "video/quicktime"
		}
		return "video/mp4"
	}
	return ""
}

// typeAliases maps the spellings real sniffers and browsers emit onto the names
// in inlineTypes. http.DetectContentType reports a WAV as "audio/wave" and an
// Ogg stream as "application/ogg" — never "audio/wav" / "audio/ogg" — so without
// this those two allowlist entries could not match anything the sniffer
// produced. The file was stored under a name ServeAs refuses, and clicking a
// playable audio file downloaded it instead of playing it.
//
// It only ever renames INTO an existing allowlist entry; it cannot admit a type
// the allowlist does not already trust. Applied in normalizeType so it also
// holds for rows stored before it existed (ServeAs normalizes the stored value)
// — no migration needed.
var typeAliases = map[string]string{
	"audio/wave":      "audio/wav",
	"audio/x-wav":     "audio/wav",
	"audio/vnd.wave":  "audio/wav",
	"application/ogg": "audio/ogg",
}

func canonicalType(t string) string {
	if c, ok := typeAliases[t]; ok {
		return c
	}
	return t
}

// normalizeType strips parameters ("; charset=utf-8"), lowercases, and folds
// known aliases onto their allowlist name (see typeAliases).
func normalizeType(t string) string {
	if t == "" {
		return ""
	}
	if parsed, _, err := mime.ParseMediaType(t); err == nil {
		return canonicalType(strings.ToLower(parsed))
	}
	if i := strings.IndexByte(t, ';'); i >= 0 {
		t = t[:i]
	}
	return canonicalType(strings.ToLower(strings.TrimSpace(t)))
}

// ServeAs maps a stored type to what we actually put on the wire.
//
// Returns the Content-Type to send and whether the response MAY be inline. A
// type not in the allowlist is downgraded to application/octet-stream — we do
// not echo the stored type back, because echoing "image/svg+xml" with
// Content-Disposition: attachment still leaves one header typo away from
// execution. Downgrading the type as well makes it fail safe twice.
func ServeAs(stored string) (contentType string, inline bool) {
	t := normalizeType(stored)
	if inlineTypes[t] {
		return t, true
	}
	return "application/octet-stream", false
}

// ServeHeaders is the Content-Type and Content-Disposition for serving a stored
// file — ServeAs, plus the EXPLICIT Download (`?dl=1`, a file's 3-dot menu →
// Download).
//
// A normal open passes forceDownload=false: a type ServeAs allows renders
// inline, everything else keeps its fail-safe octet-stream + attachment.
// forceDownload=true makes a renderable type `attachment` too, so the browser
// saves it instead of showing it.
//
// It can only ever make the response MORE restrictive. `inline` is cleared here
// and never set, and the Content-Type is ServeAs's own either way, so no caller
// input can turn an allowlist refusal into inline delivery.
func ServeHeaders(stored, filename string, forceDownload bool) (contentType, disposition string) {
	ct, inline := ServeAs(stored)
	if forceDownload {
		inline = false
	}
	return ct, ContentDisposition(inline, filename)
}

// maxFilenameBytes bounds the header we emit. 255 is the common filesystem
// limit, so anything longer would not survive a download anyway.
const maxFilenameBytes = 255

// SanitizeFilename reduces a client-supplied name to something safe to store and
// to echo in a Content-Disposition header.
//
// It strips path separators and NUL (a name is never a path here — the storage
// path is derived from the content hash, not from this), and control characters
// including CR/LF, which would otherwise permit response-header injection.
func SanitizeFilename(s string) string {
	s = strings.TrimSpace(s)
	// Take the last path element under BOTH separator conventions, so neither
	// "../../etc/passwd" nor "..\\..\\windows\\system32" survives.
	if i := strings.LastIndexAny(s, `/\`); i >= 0 {
		s = s[i+1:]
	}
	s = strings.Map(func(r rune) rune {
		if r == 0 || r == utf8.RuneError || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	// A name of dots is how you spell "the directory itself".
	if strings.Trim(s, ".") == "" {
		s = ""
	}
	if !utf8.ValidString(s) {
		s = ""
	}
	// Truncate on a rune boundary so the result stays valid UTF-8.
	for len(s) > maxFilenameBytes {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	if s == "" {
		return "file"
	}
	return s
}

// ContentDisposition builds the header value.
//
// Two forms are emitted per RFC 6266/5987: a quoted ASCII `filename=` that every
// client understands, and a percent-encoded `filename*=UTF-8”` that carries the
// real name for clients that support it. The ASCII fallback is transliterated
// rather than dropped so a non-Latin name still downloads with *something*
// readable.
func ContentDisposition(inline bool, name string) string {
	name = SanitizeFilename(name)
	disp := "attachment"
	if inline {
		disp = "inline"
	}

	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	if strings.Trim(ascii, "_") == "" {
		ascii = "file"
	}

	return fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`,
		disp, ascii, url.PathEscape(name))
}
