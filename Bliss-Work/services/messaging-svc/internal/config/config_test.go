package config

import (
	"strings"
	"testing"
)

// setRequiredEnv sets the env vars Load() demands regardless of TB_ENV, so
// each test below only needs to vary the one thing it's actually testing.
func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("MESSAGING_DATABASE_URL", "postgres://user:pass@localhost/db")
	t.Setenv("JWKS_URL", "https://auth.example.test/.well-known/jwks.json")
	t.Setenv("KAFKA_BROKERS", "kafka:9092")
	t.Setenv("MEDIA_URL_SECRET", strings.Repeat("a", 32))
}

// The dev KEK passphrase/salt are public, committed-to-source values (see the
// doc comment in Load()). If TB_ENV=production and they're still in place,
// startup must fail loudly rather than silently encrypting every org's data
// with a key anyone can read in the repo.
func TestLoad_ProductionRefusesDevMasterPassphrase(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("TB_ENV", "production")
	t.Setenv("DATA_MASTER_SALT", "a-real-salt-thats-at-least-16-bytes")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "DATA_MASTER_PASSPHRASE") {
		t.Fatalf("Load() with dev passphrase in production = %v; want an error naming DATA_MASTER_PASSPHRASE", err)
	}
}

func TestLoad_ProductionRefusesDevMasterSalt(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("TB_ENV", "production")
	t.Setenv("DATA_MASTER_PASSPHRASE", "a-real-passphrase-not-the-dev-default")

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "DATA_MASTER_SALT") {
		t.Fatalf("Load() with dev salt in production = %v; want an error naming DATA_MASTER_SALT", err)
	}
}

func TestLoad_ProductionAcceptsRealSecrets(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("TB_ENV", "production")
	t.Setenv("DATA_MASTER_PASSPHRASE", "a-real-passphrase-not-the-dev-default")
	t.Setenv("DATA_MASTER_SALT", "a-real-salt-thats-at-least-16-bytes")

	if _, err := Load(); err != nil {
		t.Fatalf("Load() with real secrets in production = %v; want no error", err)
	}
}

// Outside production the convenient dev defaults must keep working untouched
// — this check only ever fires when TB_ENV is production/prod.
func TestLoad_DevelopmentAllowsDevDefaults(t *testing.T) {
	setRequiredEnv(t)

	if _, err := Load(); err != nil {
		t.Fatalf("Load() with dev defaults and no TB_ENV = %v; want no error", err)
	}
}
