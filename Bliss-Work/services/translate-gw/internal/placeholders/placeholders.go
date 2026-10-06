// Package placeholders keeps interpolation variables, markup and URLs out of
// Google's hands.
//
// The English catalogs are full of i18next `{{count}}` / `{{name}}` variables
// and `<bold>…</bold>` Trans tags. Sent as plain text, Google is free to turn
// `{{name}}` into `{{nombre}}`, which i18next then renders literally. So each
// such token is wrapped in `<span translate="no">` and the request is sent as
// HTML (Google's documented way to say "leave this alone"); the wrappers are
// stripped from the answer.
//
// Belt and braces: after un-wrapping, the translation must contain exactly the
// same multiset of protected tokens as its source. If it does not, Restore
// reports failure and the caller keeps the English text. A visible English
// string is always better than a broken placeholder.
package placeholders

import (
	"html"
	"regexp"
	"strings"
)

// Covers: i18next `{{x}}` / `{{- x}}` / `{{x, number}}`, i18next nesting
// `$t(ns:key)`, Trans tags `<bold>` `</bold>` `<0>`, printf `%s` `%d` `%1$s`,
// single-brace `{count}`, and bare URLs.
var protected = regexp.MustCompile(strings.Join([]string{
	`\{\{[^{}]*\}\}`,
	`\$t\([^()]*\)`,
	`</?[A-Za-z0-9]+(?:\s[^<>]*)?/?>`,
	`%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?[sdif]`,
	`\{[A-Za-z0-9_]+\}`,
	`https?://[\w\-./?=&%#:@+~]+`,
}, "|"))

var noTranslateSpan = regexp.MustCompile(`(?is)<span\s+translate=["']no["']\s*>(.*?)</span\s*>`)

var escapeHTML = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// Protect returns the HTML-safe form of text with every protected token wrapped
// so Google leaves it untouched. Pair with Restore.
func Protect(text string) string {
	var b strings.Builder
	last := 0
	for _, m := range protected.FindAllStringIndex(text, -1) {
		b.WriteString(escapeHTML.Replace(text[last:m[0]]))
		b.WriteString(`<span translate="no">`)
		b.WriteString(escapeHTML.Replace(text[m[0]:m[1]]))
		b.WriteString(`</span>`)
		last = m[1]
	}
	b.WriteString(escapeHTML.Replace(text[last:]))
	return b.String()
}

// Restore returns the plain text of Google's HTML answer, or ok=false when the
// answer does not carry exactly the placeholders source had.
func Restore(translatedHTML, source string) (string, bool) {
	plain := html.UnescapeString(noTranslateSpan.ReplaceAllString(translatedHTML, "$1"))
	if !sameTokens(protected.FindAllString(plain, -1), protected.FindAllString(source, -1)) {
		return "", false
	}
	return plain, true
}

func sameTokens(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, t := range a {
		counts[t]++
	}
	for _, t := range b {
		counts[t]--
		if counts[t] < 0 {
			return false
		}
	}
	return true
}
