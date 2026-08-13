package api

import (
	"errors"
	"strings"
	"unicode"
)

// E.164 caps a subscriber number at 15 digits including the country code. The
// lower bound is a judgement call rather than a standard: the shortest real
// E.164 numbers (a few Pacific and Caribbean plans) sit at 8, and anything
// shorter reaching this endpoint is a national/local number typed without a
// country code — which would deep-link to a plausible-looking stranger rather
// than fail. Rejecting it is the safer error.
const (
	minE164Digits = 8
	maxE164Digits = 15
)

// maxContactNameRunes bounds the captured contact name. The name is written
// verbatim into a system pill the OTHER party sees, so an unbounded field is an
// impersonation surface ("Forwarded to IT Support — call +1800…"), not just a
// layout problem. Runes, not bytes: the cap should not depend on the alphabet.
const maxContactNameRunes = 64

var errBadPhone = errors.New("invalid phone number")

// normalizeE164 turns raw user input into the bare-digits form wa.me requires.
//
// wa.me takes a country code with NO leading '+' and NO leading zeroes —
// "+1 (555) 019-2834", "0044 20 7946 0958" and "15550192834" must all reduce to
// digits-only with the international prefix intact. Everything non-numeric is
// dropped first (which disposes of '+', spaces, parens, dots and dashes in one
// pass), then leading zeroes go: that covers both a trunk '0' and the '00'
// international prefix, since neither survives in E.164.
//
// No country is inferred. Guessing one would silently produce a valid-looking
// link to the wrong person, which is worse than making the user type the code.
func normalizeE164(raw string) (string, error) {
	var b strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	digits := strings.TrimLeft(b.String(), "0")
	if len(digits) < minE164Digits || len(digits) > maxE164Digits {
		return "", errBadPhone
	}
	return digits, nil
}

// isBidiOverride reports whether r can visually reorder the text around it.
// These are category Cf, not Cc, so unicode.IsControl does NOT catch them — and
// they matter here specifically because the pill renders the name immediately
// before a phone number: an embedded RLO makes the number a reader sees differ
// from the number that was stored and opened. Only the overrides are listed;
// other Cf runes (notably U+200D ZWJ) are load-bearing inside emoji and several
// scripts, so blanket-stripping Cf would mangle legitimate names.
func isBidiOverride(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// sanitizeContactName reduces a captured contact name to something safe to embed
// in a system message: no control characters, no bidi overrides, no runs of
// whitespace, and bounded length.
//
// This is not an XSS guard — React escapes text and `react/no-danger` is a
// blocking lint rule. It guards against a name that lies about its own shape.
// Two cases beyond a newline breaking the pill out of its single line:
//
//   - U+001F is the chat-envelope sentinel (packages/app/src/lib/chatEnvelope.ts:30).
//     A name carrying one would make the pill body parse as a structured payload
//     and render as an attachment or location card in someone else's thread. It
//     is Cc, so the IsControl arm below already removes it — recorded here so a
//     later simplification of that arm knows what it is holding up.
//   - bidi overrides, per isBidiOverride.
//
// An empty result is legitimate: the picker can return a number with no name and
// the manual form leaves the field optional; callers fall back to a generic label.
func sanitizeContactName(raw string) string {
	var b strings.Builder
	lastWasSpace := false
	for _, r := range raw {
		switch {
		case unicode.IsControl(r), isBidiOverride(r):
			// Drop outright rather than convert to a space — a name is not
			// meant to contain one, so it carries no information to preserve.
			continue
		case unicode.IsSpace(r):
			if !lastWasSpace {
				b.WriteRune(' ')
				lastWasSpace = true
			}
		default:
			b.WriteRune(r)
			lastWasSpace = false
		}
	}
	name := strings.TrimSpace(b.String())
	if runes := []rune(name); len(runes) > maxContactNameRunes {
		name = strings.TrimSpace(string(runes[:maxContactNameRunes]))
	}
	return name
}
