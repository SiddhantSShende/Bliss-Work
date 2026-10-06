package catalog

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/task-board/translate-gw/internal/cache"
	"github.com/task-board/translate-gw/internal/gtranslate"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func writeSource(t *testing.T) *Source {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"common.json": `{"loading":"Loading…","buttons":{"cancel":"Cancel","save":"Save"},"hello":"Hi {{name}}"}`,
		"tasks.json":  `{"empty":"No tasks yet","actions":{"cancel":"Cancel"}}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := LoadSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// fakeTranslator prefixes every text with "[target] " and counts what it saw.
type fakeTranslator struct {
	mu      sync.Mutex
	calls   int
	strs    int
	err     error
	mangle  func(string) string // optional post-processing of an answer
	delay   time.Duration
	started atomic.Int32
}

func (f *fakeTranslator) SupportedLanguages(context.Context, string) ([]gtranslate.Language, error) {
	panic("not used")
}

func (f *fakeTranslator) TranslateHTML(_ context.Context, texts []string, _, target string) ([]string, error) {
	f.started.Add(1)
	time.Sleep(f.delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.strs += len(texts)
	if f.err != nil {
		return nil, f.err
	}
	out := make([]string, len(texts))
	for i, s := range texts {
		out[i] = "[" + target + "] " + s
		if f.mangle != nil {
			out[i] = f.mangle(out[i])
		}
	}
	return out, nil
}

func newBuilder(t *testing.T, f *fakeTranslator, c cache.Cache) *Builder {
	return &Builder{Source: writeSource(t), Translator: f, Cache: c, Log: quiet()}
}

func TestSource_StringsAreDeduplicatedAndApplyKeepsShape(t *testing.T) {
	s := writeSource(t)
	if got, want := s.Strings(), []string{"Cancel", "Hi {{name}}", "Loading…", "No tasks yet", "Save"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("strings = %v", got)
	}
	out := s.Apply(map[string]string{"Cancel": "Cancelar", "Save": "Guardar"})
	want := map[string]any{
		"common": map[string]any{"loading": "Loading…", "buttons": map[string]any{"cancel": "Cancelar", "save": "Guardar"}, "hello": "Hi {{name}}"},
		"tasks":  map[string]any{"empty": "No tasks yet", "actions": map[string]any{"cancel": "Cancelar"}},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("apply = %#v", out)
	}
}

func TestLoadSource_Errors(t *testing.T) {
	if _, err := LoadSource(t.TempDir()); err == nil {
		t.Error("an empty directory must be an error")
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.json"), []byte(`{"n": 5}`), 0o600)
	if _, err := LoadSource(dir); err == nil {
		t.Error("a non-string leaf must be an error, not silently dropped")
	}
}

func TestBuild_TranslatesEachDistinctStringOnceAndProtectsPlaceholders(t *testing.T) {
	f := &fakeTranslator{}
	b := newBuilder(t, f, cache.NewMemory())
	res, err := b.Build(context.Background(), "es", "es")
	if err != nil {
		t.Fatal(err)
	}
	if f.strs != 5 {
		t.Fatalf("sent %d strings, want the 5 distinct ones", f.strs)
	}
	common := res.Namespaces["common"].(map[string]any)
	if common["hello"] != "[es] Hi {{name}}" {
		t.Fatalf("hello = %v", common["hello"])
	}
	if res.Partial || res.Locale != "es" {
		t.Fatalf("res = %+v", res)
	}
}

func TestBuild_ServedFromCacheAcrossBuildersWithoutCallingGoogle(t *testing.T) {
	shared := cache.NewMemory()
	f1 := &fakeTranslator{}
	if _, err := newBuilder(t, f1, shared).Build(context.Background(), "fr", "fr"); err != nil {
		t.Fatal(err)
	}
	f2 := &fakeTranslator{}
	res, err := newBuilder(t, f2, shared).Build(context.Background(), "fr", "fr") // a "restarted" gateway
	if err != nil {
		t.Fatal(err)
	}
	if f2.calls != 0 {
		t.Fatalf("a cached locale hit Google %d times", f2.calls)
	}
	if res.Namespaces["tasks"].(map[string]any)["empty"] != "[fr] No tasks yet" {
		t.Fatalf("cache returned %v", res.Namespaces["tasks"])
	}
}

func TestBuild_CompleteCatalogIsMemoisedForTheProcess(t *testing.T) {
	f := &fakeTranslator{}
	b := newBuilder(t, f, cache.NewMemory())
	for i := 0; i < 3; i++ {
		if _, err := b.Build(context.Background(), "de", "de"); err != nil {
			t.Fatal(err)
		}
	}
	if f.calls != 1 {
		t.Fatalf("calls = %d, want 1", f.calls)
	}
}

func TestBuild_ConcurrentRequestsShareOneBuild(t *testing.T) {
	f := &fakeTranslator{delay: 50 * time.Millisecond}
	b := newBuilder(t, f, cache.NewMemory())
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := b.Build(context.Background(), "ja", "ja"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if f.calls != 1 {
		t.Fatalf("8 concurrent requests made %d Google calls, want 1", f.calls)
	}
}

func TestBuild_MangledPlaceholderFallsBackToEnglishAndIsPartialAndNotCached(t *testing.T) {
	f := &fakeTranslator{mangle: func(s string) string { return strings.ReplaceAll(s, "{{name}}", "{{nombre}}") }}
	c := cache.NewMemory()
	b := newBuilder(t, f, c)
	res, err := b.Build(context.Background(), "es", "es")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Partial {
		t.Fatal("a dropped placeholder must make the catalog partial")
	}
	common := res.Namespaces["common"].(map[string]any)
	if common["hello"] != "Hi {{name}}" {
		t.Fatalf("hello = %v, want the English string", common["hello"])
	}
	if common["loading"] != "[es] Loading…" {
		t.Fatalf("intact strings must still be translated, got %v", common["loading"])
	}
	if got := c.GetMany(context.Background(), "es", []string{"Hi {{name}}"}); len(got) != 0 {
		t.Fatalf("a rejected translation was cached: %v", got)
	}
	// Partial results are not memoised: the next request tries again.
	if _, err := b.Build(context.Background(), "es", "es"); err != nil {
		t.Fatal(err)
	}
	if f.calls < 2 {
		t.Fatalf("partial catalog was memoised (calls=%d)", f.calls)
	}
}

func TestBuild_GoogleDownIsAnErrorNotAnEnglishCatalogUnderAForeignLocale(t *testing.T) {
	b := newBuilder(t, &fakeTranslator{err: gtranslate.ErrNotConfigured}, cache.NewMemory())
	if _, err := b.Build(context.Background(), "es", "es"); !errors.Is(err, gtranslate.ErrNotConfigured) {
		t.Fatalf("err = %v", err)
	}
}

func TestBuild_SomeBatchesFailingIsPartial(t *testing.T) {
	dir := t.TempDir()
	body := `{`
	for i := 0; i < 250; i++ {
		if i > 0 {
			body += ","
		}
		body += `"k` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `":"text number ` + strings.Repeat("x", i) + `"`
	}
	_ = os.WriteFile(filepath.Join(dir, "big.json"), []byte(body+`}`), 0o600)
	src, err := LoadSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	var n atomic.Int32
	f := &flaky{fn: func() bool { return n.Add(1) == 2 }}
	b := &Builder{Source: src, Translator: f, Cache: cache.NewMemory(), Log: quiet()}
	res, err := b.Build(context.Background(), "ko", "ko")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Partial {
		t.Fatal("one failed batch of three must be partial")
	}
}

type flaky struct{ fn func() bool }

func (f *flaky) SupportedLanguages(context.Context, string) ([]gtranslate.Language, error) {
	return nil, nil
}
func (f *flaky) TranslateHTML(_ context.Context, texts []string, _, target string) ([]string, error) {
	if f.fn() {
		return nil, errors.New("boom")
	}
	out := make([]string, len(texts))
	for i, s := range texts {
		out[i] = "[" + target + "] " + s
	}
	return out, nil
}

func TestBuild_AsksGoogleForTheGoogleTargetButKeysTheCacheByBlissWorkCode(t *testing.T) {
	f := &fakeTranslator{}
	c := cache.NewMemory()
	res, err := newBuilder(t, f, c).Build(context.Background(), "zh", "zh-CN")
	if err != nil {
		t.Fatal(err)
	}
	if res.Locale != "zh" {
		t.Fatalf("catalog locale = %q, want BlissWork's own code", res.Locale)
	}
	// The fake echoes the target it was asked for.
	if got := res.Namespaces["tasks"].(map[string]any)["empty"]; got != "[zh-CN] No tasks yet" {
		t.Fatalf("google was asked for %v", got)
	}
	if got := c.GetMany(context.Background(), "zh", []string{"Save"}); got["Save"] != "[zh-CN] Save" {
		t.Fatalf("cache must be keyed by the public code zh: %v", got)
	}
	if got := c.GetMany(context.Background(), "zh-CN", []string{"Save"}); len(got) != 0 {
		t.Fatalf("cache leaked under the Google code: %v", got)
	}
}

func TestBatches_RespectStringAndCharLimits(t *testing.T) {
	var many []string
	for i := 0; i < 250; i++ {
		many = append(many, "s"+strings.Repeat("y", i%7))
	}
	got := batches(many)
	if len(got) != 3 || len(got[0]) != 100 || len(got[2]) != 50 {
		t.Fatalf("by count: %d batches, first %d", len(got), len(got[0]))
	}
	long := strings.Repeat("a", 9000)
	got = batches([]string{long, long, long})
	if len(got) != 2 || len(got[0]) != 2 {
		t.Fatalf("by chars: %v", got)
	}
}

// The real shipped catalogs: every string must survive protect → (identity
// translation) → restore, or the catalog could never be produced intact.
func TestRealEnglishCatalog_EveryStringSurvivesPlaceholderProtection(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "packages", "app", "src", "i18n", "locales", "en")
	if _, err := os.Stat(dir); err != nil {
		t.Skip("repo English catalogs not present")
	}
	src, err := LoadSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	f := &identity{}
	b := &Builder{Source: src, Translator: f, Cache: cache.NewMemory(), Log: quiet()}
	res, err := b.Build(context.Background(), "es", "es")
	if err != nil {
		t.Fatal(err)
	}
	if res.Partial {
		t.Fatal("identity translation of the real catalog was partial: a real string fails placeholder protection")
	}
	if !reflect.DeepEqual(res.Namespaces, src.English()) {
		t.Fatal("identity translation changed the catalog")
	}
}

type identity struct{}

func (identity) SupportedLanguages(context.Context, string) ([]gtranslate.Language, error) {
	return nil, nil
}
func (identity) TranslateHTML(_ context.Context, texts []string, _, _ string) ([]string, error) {
	return texts, nil
}

// The shipped catalog through a REAL Redis: every distinct string is written once
// (under the public locale code), and a "restarted" gateway with an empty process
// but the same Redis builds the whole catalog without asking Google again.
// Skipped unless REDIS_TEST_URL is set.
func TestRealRedis_ShippedCatalogIsCachedAndServedWithoutGoogle(t *testing.T) {
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL not set")
	}
	dir := filepath.Join("..", "..", "..", "..", "packages", "app", "src", "i18n", "locales", "en")
	src, err := LoadSource(dir)
	if err != nil {
		t.Skip("repo English catalogs not present")
	}
	locale := "t" + time.Now().Format("150405.000000000") // unique: never collides with real data
	c1, err := cache.NewRedis(url, quiet())
	if err != nil {
		t.Fatal(err)
	}
	f1 := &fakeTranslator{}
	first, err := (&Builder{Source: src, Translator: f1, Cache: c1, Log: quiet()}).Build(context.Background(), locale, locale)
	if err != nil || first.Partial {
		t.Fatalf("first build: %v partial=%v", err, first != nil && first.Partial)
	}
	if f1.strs != len(src.Strings()) {
		t.Fatalf("google saw %d strings, catalog has %d distinct", f1.strs, len(src.Strings()))
	}

	c2, _ := cache.NewRedis(url, quiet()) // fresh client + empty memory: a new process
	f2 := &fakeTranslator{}
	second, err := (&Builder{Source: src, Translator: f2, Cache: c2, Log: quiet()}).Build(context.Background(), locale, locale)
	if err != nil {
		t.Fatal(err)
	}
	if f2.calls != 0 {
		t.Fatalf("restarted gateway asked Google %d times; Redis should have served everything", f2.calls)
	}
	if !reflect.DeepEqual(first.Namespaces, second.Namespaces) {
		t.Fatal("catalog from Redis differs from the one first generated")
	}
}
