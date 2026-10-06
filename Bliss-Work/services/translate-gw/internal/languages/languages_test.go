package languages

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/task-board/translate-gw/internal/gtranslate"
)

type fakeTranslator struct {
	langs []gtranslate.Language
	err   error
	calls int
}

func (f *fakeTranslator) SupportedLanguages(context.Context, string) ([]gtranslate.Language, error) {
	f.calls++
	return f.langs, f.err
}
func (f *fakeTranslator) TranslateHTML(context.Context, []string, string, string) ([]string, error) {
	panic("language discovery must never translate text")
}

var google = []gtranslate.Language{
	{Code: "af", Name: "Afrikaans"}, {Code: "de", Name: "German"}, {Code: "es", Name: "Spanish"},
	{Code: "fr", Name: "French"}, {Code: "hi", Name: "Hindi"}, {Code: "ja", Name: "Japanese"},
	{Code: "ko", Name: "Korean"}, {Code: "pt", Name: "Portuguese"}, {Code: "zh", Name: "Chinese (Simplified)"},
	{Code: "en", Name: "English"},
}

func TestList_IsConfiguredLocalesInOrderIntersectedWithGoogle(t *testing.T) {
	// "xx" is not a Google language; "af" is Google's but not configured.
	s := &Service{Translator: &fakeTranslator{langs: google}, Configured: []string{"es", "fr", "de", "xx", "hi", "pt", "ja", "zh", "ko"}}
	got, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var codes []string
	for _, l := range got {
		codes = append(codes, l.Code)
	}
	if want := []string{"es", "fr", "de", "hi", "pt", "ja", "zh", "ko"}; !reflect.DeepEqual(codes, want) {
		t.Fatalf("codes = %v, want %v", codes, want)
	}
	if got[0].Name != "Spanish" {
		t.Fatalf("names must come from Google, got %+v", got[0])
	}
}

func TestList_CachesForTTLThenRefreshes(t *testing.T) {
	f := &fakeTranslator{langs: google}
	now := time.Now()
	s := &Service{Translator: f, Configured: []string{"es"}, TTL: time.Hour, now: func() time.Time { return now }}
	for i := 0; i < 3; i++ {
		if _, err := s.List(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if f.calls != 1 {
		t.Fatalf("calls within TTL = %d, want 1", f.calls)
	}
	now = now.Add(2 * time.Hour)
	_, _ = s.List(context.Background())
	if f.calls != 2 {
		t.Fatalf("calls after TTL = %d, want 2", f.calls)
	}
}

func TestList_FailureIsNotCached(t *testing.T) {
	f := &fakeTranslator{err: gtranslate.ErrNotConfigured}
	s := &Service{Translator: f, Configured: []string{"es"}}
	if _, err := s.List(context.Background()); !errors.Is(err, gtranslate.ErrNotConfigured) {
		t.Fatalf("err = %v", err)
	}
	f.err, f.langs = nil, google
	got, err := s.List(context.Background())
	if err != nil || len(got) != 1 {
		t.Fatalf("must heal on the next call: %v %v", got, err)
	}
}

func TestList_NoneConfiguredSupportedIsEmptyNotAnError(t *testing.T) {
	s := &Service{Translator: &fakeTranslator{langs: google}, Configured: []string{"xx"}}
	got, err := s.List(context.Background())
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %v, %v; want an empty non-nil list", got, err)
	}
}

func TestResolve(t *testing.T) {
	s := &Service{Translator: &fakeTranslator{langs: google}, Configured: []string{"es", "zh"}}
	if tg, ok, err := s.Resolve(context.Background(), "ES"); err != nil || !ok || tg != (Target{Code: "es", GoogleCode: "es"}) {
		t.Fatalf("ES -> %+v %v %v", tg, ok, err)
	}
	for _, not := range []string{"fr", "en", "af"} {
		if _, ok, err := s.Resolve(context.Background(), not); err != nil || ok {
			t.Fatalf("%s must not resolve: %v %v", not, ok, err)
		}
	}
}

// Google spells Simplified Chinese "zh-CN" (and has varied on Portuguese). The
// public code must stay BlissWork's own so persisted choices and the client
// contract do not depend on Google's spelling.
func TestList_NormalizesGoogleSpellingsOfZhAndPt(t *testing.T) {
	cases := map[string]struct {
		google     []gtranslate.Language
		wantGoogle map[string]string
	}{
		"zh-CN and pt-BR": {
			[]gtranslate.Language{{Code: "zh-CN", Name: "Chinese (Simplified)"}, {Code: "zh-TW", Name: "Chinese (Traditional)"}, {Code: "pt-BR", Name: "Portuguese (Brazil)"}, {Code: "es", Name: "Spanish"}},
			map[string]string{"zh": "zh-CN", "pt": "pt-BR", "es": "es"},
		},
		"bare zh and pt": {
			[]gtranslate.Language{{Code: "zh", Name: "Chinese"}, {Code: "zh-TW", Name: "Traditional"}, {Code: "pt", Name: "Portuguese"}, {Code: "es", Name: "Spanish"}},
			map[string]string{"zh": "zh", "pt": "pt", "es": "es"},
		},
		"exact wins over alias": {
			[]gtranslate.Language{{Code: "zh-CN", Name: "A"}, {Code: "zh", Name: "B"}, {Code: "pt-PT", Name: "C"}, {Code: "pt", Name: "D"}, {Code: "es", Name: "Spanish"}},
			map[string]string{"zh": "zh", "pt": "pt", "es": "es"},
		},
		"pt-PT only": {
			[]gtranslate.Language{{Code: "pt-PT", Name: "Portuguese (Portugal)"}, {Code: "zh-Hans", Name: "Chinese"}, {Code: "es", Name: "Spanish"}},
			map[string]string{"zh": "zh-Hans", "pt": "pt-PT", "es": "es"},
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			s := &Service{Translator: &fakeTranslator{langs: c.google}, Configured: []string{"es", "pt", "zh"}}
			listed, err := s.List(context.Background())
			if err != nil || len(listed) != 3 {
				t.Fatalf("list = %v %v", listed, err)
			}
			for i, want := range []string{"es", "pt", "zh"} {
				if listed[i].Code != want {
					t.Fatalf("public code %d = %q, want %q (BlissWork's own)", i, listed[i].Code, want)
				}
			}
			for code, g := range c.wantGoogle {
				tg, ok, err := s.Resolve(context.Background(), code)
				if err != nil || !ok || tg.Code != code || tg.GoogleCode != g {
					t.Errorf("%s -> %+v %v %v, want google %q", code, tg, ok, err, g)
				}
			}
		})
	}
}

func TestList_ServesStaleListWhenGoogleFailsAfterTTL_ButNeverInventsOne(t *testing.T) {
	f := &fakeTranslator{langs: google}
	now := time.Now()
	s := &Service{Translator: f, Configured: []string{"es", "fr"}, TTL: time.Hour, now: func() time.Time { return now }}
	if _, err := s.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Hour)
	f.err = gtranslate.ErrNotConfigured
	got, err := s.List(context.Background())
	if err != nil || len(got) != 2 {
		t.Fatalf("stale list expected, got %v %v", got, err)
	}
	if _, ok, err := s.Resolve(context.Background(), "fr"); err != nil || !ok {
		t.Fatalf("resolve must also use the stale list: %v %v", ok, err)
	}
	// Recovery refreshes it.
	f.err, f.langs = nil, google[:3]
	if got, _ := s.List(context.Background()); len(got) != 1 {
		t.Fatalf("after recovery the fresh list wins, got %v", got)
	}
}
