// Package config reads translate-gw's environment. Nothing here is a Google
// credential: those come from Application Default Credentials (see gtranslate).
package config

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// SourceLanguage is the language every UI string is authored in. It is bundled
// in the client, never translated, and never listed as a translation target.
const SourceLanguage = "en"

// DefaultLocales is what the gateway offers when I18N_LOCALES is unset.
const DefaultLocales = "en,es,fr,de,hi,pt,ja,zh,ko"

// LocaleShape is the only form of locale code the gateway accepts anywhere
// (configuration and request alike): a BCP-47-ish "es", "zh-TW", "pt-BR".
var LocaleShape = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$`)

type Config struct {
	ListenAddr    string
	InternalToken string
	// Locales are the translation targets to offer, in display order, source
	// language excluded. Narrowed at runtime to what Google actually supports.
	Locales   []string
	SourceDir string
	// RedisURL is optional; empty means an in-process translation cache.
	RedisURL string
	Debug    bool
}

// Load builds a Config from getenv (os.Getenv in production).
func Load(getenv func(string) string) (Config, error) {
	locales, err := ParseLocales(getenv("I18N_LOCALES"))
	if err != nil {
		return Config{}, err
	}
	dir := getenv("I18N_SOURCE_DIR")
	if dir == "" {
		dir = "/app/i18n_source/en"
	}
	return Config{
		// Fixed in-container port; compose and the healthcheck target 8012.
		ListenAddr:    ":8012",
		InternalToken: getenv("TRANSLATE_INTERNAL_TOKEN"),
		Locales:       locales,
		SourceDir:     dir,
		RedisURL:      getenv("REDIS_URL"),
		Debug:         getenv("LOG_LEVEL") == "debug",
	}, nil
}

// ParseLocales turns a comma-separated list into ordered, de-duplicated target
// locales. Empty input means DefaultLocales. The source language is accepted in
// the list (it is "supported") but dropped, since it is never a target.
func ParseLocales(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		raw = DefaultLocales
	}
	seen := map[string]bool{}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		code := strings.TrimSpace(part)
		if code == "" {
			continue
		}
		if !LocaleShape.MatchString(code) {
			return nil, fmt.Errorf("I18N_LOCALES: %q is not a valid locale code", code)
		}
		if strings.EqualFold(code, SourceLanguage) || seen[code] {
			continue
		}
		seen[code] = true
		out = append(out, code)
	}
	if len(out) == 0 {
		return nil, errors.New("I18N_LOCALES: no translation target locales configured")
	}
	return out, nil
}
