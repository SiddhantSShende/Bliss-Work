package store

// The org's first DEK must be durable before any ciphertext under it exists,
// against a real Postgres with RLS enforcing.
//
// ── Why this needs a database ────────────────────────────────────────────────
// The DEK is created lazily by the first write that encrypts for an org, and it
// used to be inserted in that write's own transaction while the cryptor cached
// it process-wide. If the write then failed and rolled back, the row vanished
// but the cache kept the key: the retry, and every other write for the next
// cache TTL, encrypted under a key no database held. Once the cache expired the
// service minted a different first key and all of that ciphertext became
// permanently undecryptable. Only a second cryptor that has never seen the cache
// can show which key the database really holds.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's
// header for how to run it.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/crypto"
)

func TestFirstOrgKey_SurvivesTheWriteThatCreatedItRollingBack(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	writeFailed := errors.New("the write failed after encrypting")

	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := s.crypto.Encrypt(ctx, tx, orgID, "first attempt"); err != nil {
			return err
		}
		return writeFailed
	})
	if !errors.Is(err, writeFailed) {
		t.Fatalf("first write = %v, want the injected failure", err)
	}

	const plaintext = "the retry that must stay readable"
	var blob []byte
	if err := s.withOrg(ctx, orgID, func(tx pgx.Tx) (err error) {
		blob, err = s.crypto.Encrypt(ctx, tx, orgID, plaintext)
		return err
	}); err != nil {
		t.Fatalf("retried write: %v", err)
	}

	// A cryptor with an empty cache can only use what the database holds.
	kek, err := crypto.NewDevKEKProvider("lifecycle-test-passphrase", []byte("0123456789abcdef"), 1)
	if err != nil {
		t.Fatalf("dev KEK: %v", err)
	}
	cold := crypto.New(kek, time.Minute)
	var got string
	if err := s.withOrg(ctx, orgID, func(tx pgx.Tx) (err error) {
		got, err = cold.Decrypt(ctx, tx, orgID, blob)
		return err
	}); err != nil {
		t.Fatalf("decrypting with the key the database holds: %v", err)
	}
	if got != plaintext {
		t.Fatalf("decrypted %q, want %q", got, plaintext)
	}
}
