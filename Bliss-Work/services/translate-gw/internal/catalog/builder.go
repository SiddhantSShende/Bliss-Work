package catalog

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/task-board/translate-gw/internal/cache"
	"github.com/task-board/translate-gw/internal/config"
	"github.com/task-board/translate-gw/internal/gtranslate"
	"github.com/task-board/translate-gw/internal/placeholders"
)

const (
	// Google's documented limit is 128 strings / 30k code points per request;
	// stay well inside both. Counted on the protected (span-wrapped) text.
	maxBatchStrings = 100
	maxBatchChars   = 20000
	// A cold locale (never picked before) is ~18 batches; a few in flight at
	// once keeps the first switch quick without hammering Google's quota.
	maxInFlight = 4
	// buildTimeout bounds one locale build whatever the callers do.
	buildTimeout = 2 * time.Minute
)

// ErrNothingTranslated means Google was asked and every request failed, so the
// "catalog" would be English under a foreign locale code.
var ErrNothingTranslated = errors.New("no string could be translated")

// Result is the catalog the API returns: namespace-shaped like the English
// source. Partial means some strings are still English because Google failed
// or mangled them.
type Result struct {
	Locale     string
	Namespaces map[string]any
	Partial    bool
}

// Builder produces translated catalogs. Complete catalogs are memoised for the
// life of the process (the English source cannot change under a running
// gateway); partial ones are not, so a later request can finish the job.
type Builder struct {
	Source     *Source
	Translator gtranslate.Translator
	Cache      cache.Cache
	Log        *slog.Logger

	mu       sync.Mutex
	done     map[string]*Result
	inflight map[string]*call
}

type call struct {
	wg  sync.WaitGroup
	res *Result
	err error
}

// Build returns the catalog for an already-validated BlissWork locale, asking
// Google for googleTarget (usually the same code; see languages.googleAliases).
// Concurrent requests for the same locale share one build.
func (b *Builder) Build(ctx context.Context, locale, googleTarget string) (*Result, error) {
	b.mu.Lock()
	if r, ok := b.done[locale]; ok {
		b.mu.Unlock()
		return r, nil
	}
	c, running := b.inflight[locale]
	if !running {
		c = &call{}
		c.wg.Add(1)
		if b.inflight == nil {
			b.inflight = map[string]*call{}
		}
		b.inflight[locale] = c
		// Detached from this caller: if it hangs up, the build still finishes
		// for the callers waiting on it (and warms the cache).
		go b.run(context.WithoutCancel(ctx), locale, googleTarget, c)
	}
	b.mu.Unlock()

	finished := make(chan struct{})
	go func() { c.wg.Wait(); close(finished) }()
	select {
	case <-finished:
		return c.res, c.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (b *Builder) run(ctx context.Context, locale, googleTarget string, c *call) {
	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()
	c.res, c.err = b.build(ctx, locale, googleTarget)
	b.mu.Lock()
	delete(b.inflight, locale)
	if c.err == nil && !c.res.Partial {
		if b.done == nil {
			b.done = map[string]*Result{}
		}
		b.done[locale] = c.res
	}
	b.mu.Unlock()
	c.wg.Done()
}

func (b *Builder) build(ctx context.Context, locale, googleTarget string) (*Result, error) {
	sources := b.Source.Strings()
	translated := b.Cache.GetMany(ctx, locale, sources)
	var missing []string
	for _, s := range sources {
		if _, ok := translated[s]; !ok {
			missing = append(missing, s)
		}
	}

	cached := len(translated)
	partial := false
	if len(missing) > 0 {
		fresh, failed, firstErr := b.translateAll(ctx, locale, googleTarget, missing)
		for s, t := range fresh {
			translated[s] = t
		}
		b.Cache.SetMany(ctx, locale, fresh)
		partial = failed > 0
		// Nothing from the cache and nothing from Google: not a catalog at all.
		if len(fresh) == 0 && cached == 0 {
			if firstErr != nil {
				return nil, firstErr
			}
			return nil, ErrNothingTranslated
		}
	}
	return &Result{Locale: locale, Namespaces: b.Source.Apply(translated), Partial: partial}, nil
}

// translateAll translates the given strings in bounded-concurrency batches. It
// returns the strings that came back intact, how many did not, and the first
// transport/auth error (nil when every failure was a mangled placeholder).
func (b *Builder) translateAll(ctx context.Context, locale, googleTarget string, missing []string) (map[string]string, int, error) {
	var (
		mu       sync.Mutex
		wg       sync.WaitGroup
		fresh    = map[string]string{}
		failed   int
		firstErr error
		slots    = make(chan struct{}, maxInFlight)
	)
	for _, batch := range batches(missing) {
		slots <- struct{}{}
		wg.Add(1)
		go func(batch []string) {
			defer func() { <-slots; wg.Done() }()
			got, err := b.translateBatch(ctx, locale, googleTarget, batch)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failed += len(batch)
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			for s, t := range got {
				fresh[s] = t
			}
			failed += len(batch) - len(got)
		}(batch)
	}
	wg.Wait()
	return fresh, failed, firstErr
}

// translateBatch returns source -> translation for the strings whose
// placeholders survived. Strings that did not are simply absent (left English,
// and not cached, so a later attempt can still do better).
func (b *Builder) translateBatch(ctx context.Context, locale, googleTarget string, batch []string) (map[string]string, error) {
	protected := make([]string, len(batch))
	for i, s := range batch {
		protected[i] = placeholders.Protect(s)
	}
	out, err := b.Translator.TranslateHTML(ctx, protected, config.SourceLanguage, googleTarget)
	if err != nil {
		return nil, err
	}
	if len(out) != len(batch) {
		return nil, errors.New("google returned a different number of translations than were sent")
	}
	got := make(map[string]string, len(batch))
	for i, s := range batch {
		if plain, ok := placeholders.Restore(out[i], s); ok {
			got[s] = plain
		}
	}
	if dropped := len(batch) - len(got); dropped > 0 {
		b.Log.Warn("i18n_placeholder_mismatch", "locale", locale, "count", dropped)
	}
	return got, nil
}

// batches splits strings into requests under both Google limits, keeping order.
func batches(strs []string) [][]string {
	var out [][]string
	var cur []string
	chars := 0
	for _, s := range strs {
		n := len(placeholders.Protect(s))
		if len(cur) > 0 && (len(cur) >= maxBatchStrings || chars+n > maxBatchChars) {
			out = append(out, cur)
			cur, chars = nil, 0
		}
		cur = append(cur, s)
		chars += n
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}
