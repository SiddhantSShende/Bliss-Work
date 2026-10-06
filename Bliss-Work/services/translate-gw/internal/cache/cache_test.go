package cache

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestMemory_RoundTripAndPerLocaleIsolation(t *testing.T) {
	c, ctx := NewMemory(), context.Background()
	c.SetMany(ctx, "es", map[string]string{"Cancel": "Cancelar"})
	if got := c.GetMany(ctx, "es", []string{"Cancel", "Save"}); len(got) != 1 || got["Cancel"] != "Cancelar" {
		t.Fatalf("es = %v", got)
	}
	if got := c.GetMany(ctx, "fr", []string{"Cancel"}); len(got) != 0 {
		t.Fatalf("a translation leaked across locales: %v", got)
	}
}

func TestKey_ChangesWithSourceAndLocale(t *testing.T) {
	if key("es", "Cancel") == key("es", "Cancel!") || key("es", "Cancel") == key("fr", "Cancel") {
		t.Fatal("key must depend on both locale and source string")
	}
}

type fakeKV struct {
	data map[string]string
	fail error
	ttl  time.Duration
}

func (f *fakeKV) MGet(_ context.Context, keys []string) ([]any, error) {
	if f.fail != nil {
		return nil, f.fail
	}
	out := make([]any, len(keys))
	for i, k := range keys {
		if v, ok := f.data[k]; ok {
			out[i] = v
		}
	}
	return out, nil
}

func (f *fakeKV) SetMany(_ context.Context, e map[string]string, ttl time.Duration) error {
	if f.fail != nil {
		return f.fail
	}
	f.ttl = ttl
	for k, v := range e {
		f.data[k] = v
	}
	return nil
}

func TestRedis_RoundTripUsesTTL(t *testing.T) {
	store := &fakeKV{data: map[string]string{}}
	c, ctx := &Redis{store: store, fallback: NewMemory(), log: quiet()}, context.Background()
	c.SetMany(ctx, "hi", map[string]string{"Save": "सहेजें"})
	if store.ttl != TTL {
		t.Fatalf("ttl = %v", store.ttl)
	}
	if got := c.GetMany(ctx, "hi", []string{"Save", "Open"}); len(got) != 1 || got["Save"] != "सहेजें" {
		t.Fatalf("got %v", got)
	}
}

func TestRedis_FailsOpenToMemory(t *testing.T) {
	store := &fakeKV{data: map[string]string{}, fail: errors.New("connection refused to 10.0.0.1:6379")}
	c, ctx := &Redis{store: store, fallback: NewMemory(), log: quiet()}, context.Background()
	c.SetMany(ctx, "de", map[string]string{"Open": "Öffnen"}) // must not panic or error
	if got := c.GetMany(ctx, "de", []string{"Open"}); got["Open"] != "Öffnen" {
		t.Fatalf("with Redis down the in-process fallback should still serve it, got %v", got)
	}
}

// Against a REAL Redis. Skipped unless REDIS_TEST_URL is set (same convention as
// ws-gateway's presence tests), so the default run stays a pure unit run.
func TestRedis_RealServer(t *testing.T) {
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL not set")
	}
	c, err := NewRedis(url, quiet())
	if err != nil {
		t.Fatal(err)
	}
	ctx, loc := context.Background(), "t"+time.Now().Format("150405.000000000")
	c.SetMany(ctx, loc, map[string]string{"Save": "सहेजें", "Open": "Öffnen"})
	got := c.GetMany(ctx, loc, []string{"Save", "Open", "Missing"})
	if len(got) != 2 || got["Save"] != "सहेजें" || got["Open"] != "Öffnen" {
		t.Fatalf("round trip through real Redis = %v", got)
	}
	if len(c.fallback.m) != 0 {
		t.Fatal("a healthy Redis must not be shadowed by the in-process fallback")
	}
}
