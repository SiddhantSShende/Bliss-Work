// Package cache stores per-string translations, keyed by locale plus the
// SHA-256 of the English source string. A changed English string hashes to a
// different key, so nothing is ever invalidated by hand and the same string is
// never sent to Google twice per locale, however many users or restarts ask.
//
// Both implementations fail OPEN: a cache problem costs one extra Google call,
// never a failed or wrong response.
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// TTL is a housekeeping ceiling against unbounded growth from strings that get
// renamed or removed. Freshness is guaranteed by the key, not by expiry.
const TTL = 90 * 24 * time.Hour

// Cache maps (locale, English source string) -> translated string.
type Cache interface {
	// GetMany returns source -> translation for whichever sources are cached.
	GetMany(ctx context.Context, locale string, sources []string) map[string]string
	SetMany(ctx context.Context, locale string, translations map[string]string)
}

// key v1: the key schema. Bump it to retire every entry written under a rule
// that has since changed (e.g. placeholder protection).
func key(locale, source string) string {
	sum := sha256.Sum256([]byte(source))
	return "i18n:gw:v1:en:" + locale + ":" + hex.EncodeToString(sum[:])
}

// Memory is the in-process cache: the whole cache when REDIS_URL is unset, and
// the fallback while Redis is down.
type Memory struct {
	mu sync.RWMutex
	m  map[string]string
}

func NewMemory() *Memory { return &Memory{m: map[string]string{}} }

func (c *Memory) GetMany(_ context.Context, locale string, sources []string) map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]string, len(sources))
	for _, s := range sources {
		if v, ok := c.m[key(locale, s)]; ok {
			out[s] = v
		}
	}
	return out
}

func (c *Memory) SetMany(_ context.Context, locale string, translations map[string]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for s, v := range translations {
		c.m[key(locale, s)] = v
	}
}
