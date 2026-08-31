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
	Port        string
	DatabaseURL string
	// DatabaseReplicaURL is an OPTIONAL read-only endpoint. When set, the
	// store opens a second, smaller pool and a deliberately-chosen set of
	// lag-tolerant reads is routed to it (see store.withReplicaOrg). Empty
	// means every read goes to the primary, exactly as before.
	DatabaseReplicaURL string
	KafkaBrokers       []string
	JWKSURL            string
	JWTIssuer          string
	WebOrigin          string

	// RedisURL is OPTIONAL and, when set, makes rate limiting fleet-wide: every
	// pod draws a caller's tokens from one bucket instead of keeping its own.
	// Without it the limiter is per-pod, which means a caller's real allowance
	// is the configured one times the replica count.
	//
	// One URL, or several comma-separated for a cluster — the same spelling
	// ws-gateway's REDIS_URL accepts. Losing Redis degrades the limiter to
	// per-pod; it never fails a request.
	RedisURL string

	// At-rest column encryption (envelope: per-org DEK wrapped by a KEK).
	// Names + dev defaults mirror auth-svc/app/config.py so a passphrase yields
	// the same KEK across services and languages.
	Data DataConfig

	// Chat attachments (images, video, files) and the static-map cache.
	Media MediaConfig

	// Static map thumbnails for shared locations. Entirely optional.
	Maps MapsConfig

	// The SFU that carries group call media. Optional: leave all three unset
	// and group calls report "not configured" rather than failing obscurely.
	LiveKit LiveKitConfig
}

// LiveKitConfig points at the SFU and holds the secret its room tokens are
// signed with. The secret never leaves this service — tokens are minted here,
// per call, after the caller's access has been checked against the database.
type LiveKitConfig struct {
	APIKey    string // LIVEKIT_API_KEY
	APISecret string // LIVEKIT_API_SECRET — signs room tokens; treat as a credential
	URL       string // LIVEKIT_URL — public wss:// endpoint the browser dials

	// Recording is OFF unless RECORDINGS_ENABLED is set, and it is off by
	// default for an infrastructural reason rather than a product one: LiveKit
	// Egress is a SEPARATE process that reaches the SFU over Redis, and a
	// single-node SFU deployment does not necessarily run either. Switching
	// this on without that deployment gives every call a recording that
	// immediately fails, which is worse than no recording at all.
	RecordingsEnabled bool // RECORDINGS_ENABLED
	// APIURL overrides the http(s) base derived from URL, for a service that
	// reaches the SFU on an internal address the browser cannot.
	APIURL string // LIVEKIT_API_URL
	// EgressRoot is the blob root AS THE EGRESS CONTAINER SEES IT, used only
	// when recordings go to a shared volume rather than to S3. Egress writes
	// through its own filesystem, so this is its mount point and not
	// necessarily this service's MEDIA_ROOT.
	EgressRoot string // RECORDINGS_EGRESS_ROOT
}

// MediaConfig configures persisted chat attachments.
type MediaConfig struct {
	Root          string        // MEDIA_ROOT — blob volume mount point
	MaxBytes      int64         // MEDIA_MAX_BYTES — hard per-file cap
	OrgDailyBytes int64         // MEDIA_ORG_DAILY_BYTES — rolling per-org quota
	URLSecret     string        // MEDIA_URL_SECRET — HMAC key for download URLs
	URLTTL        time.Duration // MEDIA_URL_TTL_SECONDS — download link lifetime
	UploadTTL     time.Duration // MEDIA_UPLOAD_TTL_SECONDS — uncommitted blob lifetime

	// Backend selects where the bytes actually live: "fs" (default) or "s3".
	//
	// Defaulting to fs is deliberate. Local disk is what pins this service to a
	// single replica — two pods do not share a volume, so one accepts an upload
	// and the other 404s the download — but flipping the default would silently
	// point an existing deployment at an empty bucket and 404 every attachment
	// ever uploaded. Moving is an explicit act with a migration attached; see
	// scripts/migrate-blobs-to-s3.sh.
	Backend string // MEDIA_BACKEND
	S3      S3Config
}

// S3Config addresses any S3-compatible object store (MinIO, S3, R2, Spaces).
// Ignored unless MEDIA_BACKEND=s3.
type S3Config struct {
	Endpoint  string // MEDIA_S3_ENDPOINT — host:port, no scheme
	Bucket    string // MEDIA_S3_BUCKET
	AccessKey string // MEDIA_S3_ACCESS_KEY
	SecretKey string // MEDIA_S3_SECRET_KEY
	Region    string // MEDIA_S3_REGION
	UseSSL    bool   // MEDIA_S3_USE_SSL — false only for an in-cluster MinIO
	Prefix    string // MEDIA_S3_PREFIX — lets one bucket hold several environments
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
		Port:               getenv("MESSAGING_PORT", "8004"),
		DatabaseURL:        os.Getenv("MESSAGING_DATABASE_URL"),
		DatabaseReplicaURL: os.Getenv("MESSAGING_DATABASE_REPLICA_URL"),
		RedisURL:           os.Getenv("REDIS_URL"),
		JWKSURL:            os.Getenv("JWKS_URL"),
		JWTIssuer:          getenv("JWT_ISSUER", "task-board"),
		WebOrigin:          getenv("WEB_ORIGIN", "http://localhost:5173"),
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
			Backend:       strings.ToLower(strings.TrimSpace(getenv("MEDIA_BACKEND", "fs"))),
			S3: S3Config{
				Endpoint:  os.Getenv("MEDIA_S3_ENDPOINT"),
				Bucket:    os.Getenv("MEDIA_S3_BUCKET"),
				AccessKey: os.Getenv("MEDIA_S3_ACCESS_KEY"),
				SecretKey: os.Getenv("MEDIA_S3_SECRET_KEY"),
				Region:    getenv("MEDIA_S3_REGION", "us-east-1"),
				UseSSL:    getenvBool("MEDIA_S3_USE_SSL", true),
				Prefix:    os.Getenv("MEDIA_S3_PREFIX"),
			},
		},
		Maps: MapsConfig{
			Provider: getenv("MAPS_STATIC_PROVIDER", "geoapify"),
			APIKey:   os.Getenv("MAPS_STATIC_API_KEY"),
		},
		LiveKit: LiveKitConfig{
			APIKey:            os.Getenv("LIVEKIT_API_KEY"),
			APISecret:         os.Getenv("LIVEKIT_API_SECRET"),
			URL:               os.Getenv("LIVEKIT_URL"),
			RecordingsEnabled: getenvBool("RECORDINGS_ENABLED", false),
			APIURL:            os.Getenv("LIVEKIT_API_URL"),
			EgressRoot:        os.Getenv("RECORDINGS_EGRESS_ROOT"),
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
	// Mirrors the Python services' TB_ENV=production fail-closed check
	// (auth-svc/app/config.py _enforce_prod_safety): the dev KEK
	// passphrase/salt are public, committed-to-source values, so leaving
	// them in place in production would encrypt every message body, mail,
	// and call transcript with a key anyone can read in the repo. Fail
	// loudly at boot rather than silently running with no real
	// confidentiality at rest.
	tbEnv := strings.ToLower(strings.TrimSpace(getenv("TB_ENV", "development")))
	if tbEnv == "production" || tbEnv == "prod" {
		if c.Data.MasterPassphrase == "dev-master-passphrase-change-me" {
			return nil, fmt.Errorf("DATA_MASTER_PASSPHRASE is still the dev default; refusing to start in production")
		}
		if c.Data.MasterSalt == "dev-master-salt-change-me-16+bytes" {
			return nil, fmt.Errorf("DATA_MASTER_SALT is still the dev default; refusing to start in production")
		}
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
	// Fail closed on the backend. A typo like MEDIA_BACKEND=S3-compatible must
	// not quietly fall through to local disk: the operator would believe they
	// had moved to object storage, scale to two replicas on the strength of it,
	// and get attachments that 404 on roughly half of all requests.
	switch c.Media.Backend {
	case "fs":
	case "s3":
		for k, v := range map[string]string{
			"MEDIA_S3_ENDPOINT":   c.Media.S3.Endpoint,
			"MEDIA_S3_BUCKET":     c.Media.S3.Bucket,
			"MEDIA_S3_ACCESS_KEY": c.Media.S3.AccessKey,
			"MEDIA_S3_SECRET_KEY": c.Media.S3.SecretKey,
		} {
			if strings.TrimSpace(v) == "" {
				return nil, fmt.Errorf("%s is required when MEDIA_BACKEND=s3", k)
			}
		}
	default:
		return nil, fmt.Errorf("MEDIA_BACKEND must be \"fs\" or \"s3\", got %q", c.Media.Backend)
	}
	// Recording needs an SFU to record and somewhere to put the file. Both are
	// checked here rather than at the first call, because "recording silently
	// did nothing" is the failure this feature must not have.
	if c.LiveKit.RecordingsEnabled {
		if c.LiveKit.APISecret == "" {
			return nil, fmt.Errorf("RECORDINGS_ENABLED needs LIVEKIT_API_KEY/SECRET/URL")
		}
		if c.Media.Backend == "fs" && strings.TrimSpace(c.LiveKit.EgressRoot) == "" {
			return nil, fmt.Errorf(
				"RECORDINGS_EGRESS_ROOT is required with MEDIA_BACKEND=fs: " +
					"it is the path the egress container has the media volume mounted at")
		}
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

// getenvBool parses the usual spellings of yes and no. An unset or unparseable
// value falls back to def rather than to false: MEDIA_S3_USE_SSL defaults to
// TRUE, and a typo silently downgrading a production connection to plaintext is
// exactly the failure this avoids.
func getenvBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}
