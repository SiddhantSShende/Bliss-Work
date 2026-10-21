package config

import (
	"fmt"
	"os"
	"strings"
)

// Config holds all runtime configuration sourced from the environment.
type Config struct {
	Port         string
	DatabaseURL  string
	KafkaBrokers []string
	JWKSURL      string
	JWTIssuer    string
	WebOrigin    string
	LogLevel     string
	// AuthInternalBase / AuthInternalToken: auth-svc's internal base URL and
	// shared X-Internal-Token secret, used to resolve an org's admins for
	// billing notifications (see internal/orgadmins and internal/consumer/
	// billing.go). Same env var names as email-worker and telemetry-svc,
	// which already call auth-svc's internal endpoints this same way.
	AuthInternalBase  string
	AuthInternalToken string
}

// Load reads configuration from environment variables, applying sensible
// defaults that match docker-compose / .env.example.
func Load() (*Config, error) {
	cfg := &Config{
		// Fixed in-container port; compose maps ${NOTIFICATION_PORT}:8003 and the
		// healthcheck targets 8003 inside the container.
		Port:        "8003",
		DatabaseURL: os.Getenv("NOTIFICATION_DATABASE_URL"),
		JWKSURL:     os.Getenv("JWKS_URL"),
		JWTIssuer:   getEnv("JWT_ISSUER", "task-board"),
		WebOrigin:   getEnv("WEB_ORIGIN", "http://localhost:5173"),
		LogLevel:    getEnv("LOG_LEVEL", "info"),
		// Optional: unset means the admins lookup is never attempted (see
		// orgadmins wiring in main.go) rather than the service failing to
		// start — mirrors billing_internal_base's own optional posture in
		// auth-svc's app/config.py.
		AuthInternalBase:  getEnv("AUTH_INTERNAL_BASE", "http://auth-svc:8001"),
		AuthInternalToken: os.Getenv("AUTH_INTERNAL_TOKEN"),
	}

	brokers := getEnv("KAFKA_BROKERS", "kafka:9092")
	for _, b := range strings.Split(brokers, ",") {
		if b = strings.TrimSpace(b); b != "" {
			cfg.KafkaBrokers = append(cfg.KafkaBrokers, b)
		}
	}

	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("NOTIFICATION_DATABASE_URL is required")
	}
	if cfg.JWKSURL == "" {
		return nil, fmt.Errorf("JWKS_URL is required")
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
