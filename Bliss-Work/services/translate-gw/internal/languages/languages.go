// Package languages decides which locales BlissWork offers: the configured
// allow-list (I18N_LOCALES) intersected with what Google Cloud Translation
// actually supports right now. The client never holds a list of its own.
package languages

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/task-board/translate-gw/internal/gtranslate"
)

// DisplayLanguage is the language the returned names are written in.
const DisplayLanguage = "en"

const defaultTTL = 24 * time.Hour

// googleAliases maps a BlissWork locale code to the codes Google may use for the
// same language, tried in order when Google does not list the code itself. Google
// spells Simplified Chinese "zh-CN" (documented as "zh-CN or zh") and has
// historically varied on Portuguese regions. BlissWork's own code ("zh", "pt")
// stays the public identity — it is what clients persist as `tb-locale` and send
// back — and only the Google-facing target is translated.
var googleAliases = map[string][]string{
	"zh": {"zh-CN", "zh-Hans"},
	"pt": {"pt-BR", "pt-PT"},
}

// Target is an offered locale: Code is BlissWork's public code, GoogleCode is
// what Google is asked to translate into (usually identical).
type Target struct {
	Code       string
	GoogleCode string
}

// Service caches the intersection for TTL. With no previous list a Google
// failure is returned to the caller (and never cached); with one, the stale list
// is served until Google answers again.
type Service struct {
	Translator gtranslate.Translator
	// Configured are the target locales to offer, in display order.
	Configured []string
	Log        *slog.Logger
	TTL        time.Duration

	now func() time.Time

	mu      sync.Mutex
	cached  []gtranslate.Language
	targets []Target
	expires time.Time
}

func (s *Service) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// List returns the offered languages in configured order. English is never in
// it: it is the bundled source language, not a translation target.
func (s *Service) List(ctx context.Context) ([]gtranslate.Language, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refresh(ctx); err != nil {
		return nil, err
	}
	return s.cached, nil
}

// refresh (caller holds mu) reloads the intersection when it is missing or stale.
func (s *Service) refresh(ctx context.Context) error {
	if s.cached != nil && s.clock().Before(s.expires) {
		return nil
	}
	google, err := s.Translator.SupportedLanguages(ctx, DisplayLanguage)
	if err != nil {
		// Stale-if-error: a previously verified list beats failing every
		// request because Google or ADC blipped after the TTL lapsed. Nothing
		// is cached on failure, so the next call retries.
		if s.cached != nil {
			if s.Log != nil {
				s.Log.Warn("i18n_languages_stale", "error_type", fmt.Sprintf("%T", err))
			}
			return nil
		}
		return err
	}
	byCode := make(map[string]gtranslate.Language, len(google))
	for _, l := range google {
		byCode[strings.ToLower(l.Code)] = l
	}
	offered := make([]gtranslate.Language, 0, len(s.Configured))
	targets := make([]Target, 0, len(s.Configured))
	for _, code := range s.Configured {
		l, ok := byCode[strings.ToLower(code)]
		if !ok {
			for _, alias := range googleAliases[strings.ToLower(code)] {
				if l, ok = byCode[strings.ToLower(alias)]; ok {
					if s.Log != nil {
						s.Log.Info("i18n_locale_alias", "locale", code, "google_code", l.Code)
					}
					break
				}
			}
		}
		if !ok {
			if s.Log != nil {
				s.Log.Warn("i18n_locale_unsupported_by_google", "locale", code)
			}
			continue
		}
		offered = append(offered, gtranslate.Language{Code: code, Name: l.Name})
		targets = append(targets, Target{Code: code, GoogleCode: l.Code})
	}
	ttl := s.TTL
	if ttl == 0 {
		ttl = defaultTTL
	}
	s.cached, s.targets, s.expires = offered, targets, s.clock().Add(ttl)
	return nil
}

// Resolve maps a requested locale to its offered Target. ok=false means it is
// not offered (not an error); err means Google could not be asked.
func (s *Service) Resolve(ctx context.Context, locale string) (t Target, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.refresh(ctx); err != nil {
		return Target{}, false, err
	}
	for _, t := range s.targets {
		if strings.EqualFold(t.Code, locale) {
			return t, true, nil
		}
	}
	return Target{}, false, nil
}
