package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime configuration, sourced exclusively from the environment.
type Config struct {
	Port         string
	DatabaseURL  string
	KafkaBrokers []string
	JWKSURL      string
	JWTIssuer    string
	WebOrigin    string

	// At-rest column encryption (envelope: per-org DEK wrapped by a KEK).
	// Names + dev defaults mirror auth-svc/app/config.py so a passphrase yields
	// the same KEK across services and languages.
	Data DataConfig
}

// DataConfig is the at-rest encryption configuration. provider "dev" derives an
// Argon2id master KEK from a passphrase; "kms" routes to an external KMS/Vault
// (stub today, fail-closed).
type DataConfig struct {
	KEKProvider       string  // "dev" | "kms"
	MasterPassphrase  string  // dev KEK passphrase
	MasterSalt        string  // dev KEK salt (>= 16 bytes)
	KEKVersion        int     // dev KEK rotation version
	DEKCacheTTLSecond float64 // per-org DEK cache TTL
	KMSBackend        string  // aws-kms | gcp-kms | vault-transit
	KMSKeyID          string  // required when KEKProvider == "kms"
	VaultAddr         string  // Vault address (vault-transit backend)
	VaultToken        string  // Vault token (vault-transit backend)
}

// Load reads configuration from environment variables, applying sane local defaults.
func Load() (*Config, error) {
	c := &Config{
		Port:        getenv("MESSAGING_PORT", "8004"),
		DatabaseURL: os.Getenv("MESSAGING_DATABASE_URL"),
		JWKSURL:     os.Getenv("JWKS_URL"),
		JWTIssuer:   getenv("JWT_ISSUER", "task-board"),
		WebOrigin:   getenv("WEB_ORIGIN", "http://localhost:5173"),
		Data: DataConfig{
			KEKProvider:       getenv("DATA_KEK_PROVIDER", "dev"),
			MasterPassphrase:  getenv("DATA_MASTER_PASSPHRASE", "dev-master-passphrase-change-me"),
			MasterSalt:        getenv("DATA_MASTER_SALT", "dev-master-salt-change-me-16+bytes"),
			KEKVersion:        getenvInt("DATA_KEK_VERSION", 1),
			DEKCacheTTLSecond: getenvFloat("DATA_DEK_CACHE_TTL_SECONDS", 300.0),
			KMSBackend:        getenv("DATA_KMS_BACKEND", "vault-transit"),
			KMSKeyID:          os.Getenv("DATA_KMS_KEY_ID"),
			VaultAddr:         os.Getenv("VAULT_ADDR"),
			VaultToken:        os.Getenv("VAULT_TOKEN"),
		},
	}

	brokers := getenv("KAFKA_BROKERS", "kafka:9092")
	for _, b := range strings.Split(brokers, ",") {
		if b = strings.TrimSpace(b); b != "" {
			c.KafkaBrokers = append(c.KafkaBrokers, b)
		}
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("MESSAGING_DATABASE_URL is required")
	}
	if c.JWKSURL == "" {
		return nil, fmt.Errorf("JWKS_URL is required")
	}
	if len(c.KafkaBrokers) == 0 {
		return nil, fmt.Errorf("KAFKA_BROKERS is required")
	}
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getenvFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
