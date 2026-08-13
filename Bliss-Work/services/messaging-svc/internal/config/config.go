package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
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

	// Chat attachments (images, video, files) and the static-map cache.
	Media MediaConfig

	// Static map thumbnails for shared locations. Entirely optional.
	Maps MapsConfig
}

// MediaConfig configures persisted chat attachments.
type MediaConfig struct {
	Root          string        // MEDIA_ROOT — blob volume mount point
	MaxBytes      int64         // MEDIA_MAX_BYTES — hard per-file cap
	OrgDailyBytes int64         // MEDIA_ORG_DAILY_BYTES — rolling per-org quota
	URLSecret     string        // MEDIA_URL_SECRET — HMAC key for download URLs
	URLTTL        time.Duration // MEDIA_URL_TTL_SECONDS — download link lifetime
	UploadTTL     time.Duration // MEDIA_UPLOAD_TTL_SECONDS — uncommitted blob lifetime
}

// MapsConfig configures the server-side static map proxy. An empty APIKey
// disables the feature entirely: location sharing then renders as a coordinates
// card with an "Open in Maps" link, which needs no third-party account at all.
type MapsConfig struct {
	Provider string // MAPS_STATIC_PROVIDER — "geoapify" | "maptiler"
	APIKey   string // MAPS_STATIC_API_KEY — "" disables static map thumbnails
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
		Media: MediaConfig{
			Root:          getenv("MEDIA_ROOT", "/var/lib/blisswork/media"),
			MaxBytes:      int64(getenvInt("MEDIA_MAX_BYTES", 100<<20)),
			OrgDailyBytes: int64(getenvInt("MEDIA_ORG_DAILY_BYTES", 5<<30)),
			URLSecret:     os.Getenv("MEDIA_URL_SECRET"),
			URLTTL:        time.Duration(getenvInt("MEDIA_URL_TTL_SECONDS", 600)) * time.Second,
			UploadTTL:     time.Duration(getenvInt("MEDIA_UPLOAD_TTL_SECONDS", 86400)) * time.Second,
		},
		Maps: MapsConfig{
			Provider: getenv("MAPS_STATIC_PROVIDER", "geoapify"),
			APIKey:   os.Getenv("MAPS_STATIC_API_KEY"),
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
	// Required, with no default, deliberately. This key signs every attachment
	// download URL: a defaulted or guessable value is not a degraded mode, it is
	// a universal read primitive over every file in every org. Fail at boot.
	// (Rotating it later only invalidates outstanding links — they re-mint
	// within the TTL — so it is safe to change; it is not safe to omit.)
	if len(c.Media.URLSecret) < 32 {
		return nil, fmt.Errorf("MEDIA_URL_SECRET is required and must be at least 32 bytes (openssl rand -hex 32)")
	}
	if c.Media.MaxBytes <= 0 {
		return nil, fmt.Errorf("MEDIA_MAX_BYTES must be positive")
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
