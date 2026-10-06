package config

import (
	"reflect"
	"testing"
)

func TestParseLocales(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", []string{"es", "fr", "de", "hi", "pt", "ja", "zh", "ko"}}, // default; English is the source, not a target
		{"en,es,fr,de,hi,pt,ja,zh,ko", []string{"es", "fr", "de", "hi", "pt", "ja", "zh", "ko"}},
		{" fr , es,fr, EN ", []string{"fr", "es"}},
		{"zh-TW,pt-BR", []string{"zh-TW", "pt-BR"}},
	}
	for _, c := range cases {
		got, err := ParseLocales(c.in)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseLocales(%q) = %v, %v; want %v", c.in, got, err, c.want)
		}
	}
}

func TestParseLocales_RejectsGarbageAndEnglishOnly(t *testing.T) {
	for _, in := range []string{"es,../etc", "e", "es;fr", "en"} {
		if got, err := ParseLocales(in); err == nil {
			t.Errorf("ParseLocales(%q) = %v, want an error", in, got)
		}
	}
}

func TestLoad(t *testing.T) {
	env := map[string]string{"TRANSLATE_INTERNAL_TOKEN": "tok", "REDIS_URL": "redis://x", "LOG_LEVEL": "debug"}
	cfg, err := Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.InternalToken != "tok" || cfg.RedisURL != "redis://x" || !cfg.Debug || cfg.SourceDir != "/app/i18n_source/en" || cfg.ListenAddr != ":8012" {
		t.Fatalf("cfg = %+v", cfg)
	}
}
