// Package config reads sticky-relay's runtime configuration from the
// environment, in the same shape as every other Go service here.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// sweepBatchLimitCap mirrors sticky-svc's own _MAX_LIMIT
// (services/sticky-svc/app/routes/internal.py): the /internal/pins/undelivered
// endpoint rejects any limit above this with a 422, so an operator-set
// SWEEP_BATCH_LIMIT above it would fail every sweep tick silently instead of
// just being capped here.
const sweepBatchLimitCap = 500

type Config struct {
	StickyBase    string
	InternalToken string
	KafkaBrokers  []string
	MetricsPort   string
	LogLevel      string

	// How often a sweep runs.
	SweepInterval time.Duration
	// How long an open, unconfirmed pin must have existed before it is eligible
	// for a nudge at all. Below this the client's own delivery is still in
	// flight and a nudge would be pure noise.
	StaleAfter time.Duration
	// Page size per sweep. Also the blast-radius ceiling: at most this many
	// pins can be claimed in one pass.
	BatchLimit int

	// Publish nothing; log what would have been sent. The intended first deploy
	// — see the package doc in internal/emit.
	DryRun bool
}

func Load() (*Config, error) {
	cfg := &Config{
		StickyBase:    getEnv("STICKY_INTERNAL_BASE", "http://sticky-svc:8008"),
		InternalToken: os.Getenv("STICKY_INTERNAL_TOKEN"),
		MetricsPort:   getEnv("METRICS_PORT", "8010"),
		LogLevel:      getEnv("LOG_LEVEL", "info"),
		SweepInterval: getDuration("SWEEP_INTERVAL_S", 60*time.Second),
		StaleAfter:    getDuration("STALE_AFTER_S", 5*time.Minute),
		BatchLimit:    min(getInt("SWEEP_BATCH_LIMIT", 100), sweepBatchLimitCap),
		DryRun:        getEnv("DRY_RUN", "false") == "true",
	}

	brokers := getEnv("KAFKA_BROKERS", "kafka:9092")
	for _, b := range strings.Split(brokers, ",") {
		if b = strings.TrimSpace(b); b != "" {
			cfg.KafkaBrokers = append(cfg.KafkaBrokers, b)
		}
	}

	// Fail closed rather than sweeping with an empty token and getting 403s
	// forever while reporting healthy.
	if cfg.InternalToken == "" {
		return nil, fmt.Errorf("STICKY_INTERNAL_TOKEN is required")
	}
	if len(cfg.KafkaBrokers) == 0 {
		return nil, fmt.Errorf("KAFKA_BROKERS is required")
	}
	return cfg, nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func getDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return def
}
