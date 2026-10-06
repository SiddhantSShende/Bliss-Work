package cache

import (
	"context"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// kv is the slice of Redis this cache needs; an interface so tests need no server.
type kv interface {
	MGet(ctx context.Context, keys []string) ([]any, error)
	SetMany(ctx context.Context, entries map[string]string, ttl time.Duration) error
}

// Redis is a Cache backed by Redis, falling back to an in-process Memory for
// any call Redis fails.
type Redis struct {
	store    kv
	fallback *Memory
	log      *slog.Logger
}

// NewRedis builds a Redis-backed cache from a redis:// or rediss:// URL. The URL
// (which carries the password) is never logged.
func NewRedis(url string, log *slog.Logger) (*Redis, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	opts.ReadTimeout, opts.WriteTimeout, opts.DialTimeout = 2*time.Second, 2*time.Second, 2*time.Second
	return &Redis{store: goRedis{redis.NewClient(opts)}, fallback: NewMemory(), log: log}, nil
}

func (c *Redis) GetMany(ctx context.Context, locale string, sources []string) map[string]string {
	if len(sources) == 0 {
		return map[string]string{}
	}
	keys := make([]string, len(sources))
	for i, s := range sources {
		keys[i] = key(locale, s)
	}
	values, err := c.store.MGet(ctx, keys)
	if err != nil {
		c.log.Warn("i18n_redis_error", "op", "mget", "error_type", errType(err))
		return c.fallback.GetMany(ctx, locale, sources)
	}
	out := make(map[string]string, len(sources))
	for i, v := range values {
		if s, ok := v.(string); ok {
			out[sources[i]] = s
		}
	}
	return out
}

func (c *Redis) SetMany(ctx context.Context, locale string, translations map[string]string) {
	if len(translations) == 0 {
		return
	}
	entries := make(map[string]string, len(translations))
	for s, v := range translations {
		entries[key(locale, s)] = v
	}
	if err := c.store.SetMany(ctx, entries, TTL); err != nil {
		c.log.Warn("i18n_redis_error", "op", "set", "error_type", errType(err))
		c.fallback.SetMany(ctx, locale, translations)
	}
}

type goRedis struct{ c *redis.Client }

func (r goRedis) MGet(ctx context.Context, keys []string) ([]any, error) {
	return r.c.MGet(ctx, keys...).Result()
}

func (r goRedis) SetMany(ctx context.Context, entries map[string]string, ttl time.Duration) error {
	pipe := r.c.Pipeline()
	for k, v := range entries {
		pipe.Set(ctx, k, v, ttl)
	}
	_, err := pipe.Exec(ctx)
	return err
}
