package config

import (
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime configuration sourced from environment variables.
type Config struct {
	Port         string
	JWKSURL      string
	JWTIssuer    string
	RedisURL     string
	KafkaBrokers []string
	WebOrigin    string
	LogLevel     string
	// Phase 5: messaging-svc internal endpoint for delivery acks. The gateway
	// translates a client-side `message.ack` frame into a POST against this
	// service so messaging-svc can emit MessageDelivered through its outbox
	// (preserves the outbox-then-Kafka invariant — gateway never produces).
	MessagingBaseInternal string
	// Shared secret presented in the X-Internal-Token header. Both processes
	// pick this up from the same env var (TB_INTERNAL_TOKEN) — never log it.
	InternalToken string
	// MaxConnections caps the number of concurrent WebSockets this node accepts.
	// Beyond it the upgrade is rejected (1013 Try Again Later) so a connection
	// storm can't OOM the pod. 0 = unlimited.
	MaxConnections int
	// MaxConnsPerUser caps concurrent sockets for a single user (web + desktop +
	// a few tabs is normal; a runaway reconnect loop is not). 0 = unlimited.
	MaxConnsPerUser int
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

// Load reads configuration from the environment, applying sensible defaults.
func Load() Config {
	brokers := strings.Split(getenv("KAFKA_BROKERS", "kafka:9092"), ",")
	for i := range brokers {
		brokers[i] = strings.TrimSpace(brokers[i])
	}
	return Config{
		// The container always listens on 8080 (compose maps ${WS_GATEWAY_PORT}:8080).
		Port:                  "8080",
		JWKSURL:               getenv("JWKS_URL", "http://auth-svc:8001/.well-known/jwks.json"),
		JWTIssuer:             getenv("JWT_ISSUER", "task-board"),
		RedisURL:              getenv("REDIS_URL", "redis://redis:6379/0"),
		KafkaBrokers:          brokers,
		WebOrigin:             getenv("WEB_ORIGIN", "http://localhost:5173"),
		LogLevel:              getenv("LOG_LEVEL", "info"),
		MessagingBaseInternal: getenv("TB_MESSAGING_INTERNAL_BASE", "http://messaging-svc:8004"),
		InternalToken:         getenv("TB_INTERNAL_TOKEN", "dev-internal-token"),
		MaxConnections:        getenvInt("WS_MAX_CONNECTIONS", 50000),
		MaxConnsPerUser:       getenvInt("WS_MAX_CONNS_PER_USER", 20),
	}
}
