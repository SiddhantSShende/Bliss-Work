package crypto

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeDB is an in-memory stand-in for the org_keys table that satisfies the
// crypto.Querier interface. It supports exactly the two statements the Cryptor
// issues: the INSERT ... ON CONFLICT DO NOTHING and the two SELECTs.
type fakeDB struct {
	// keyed by (org, version) -> wrapped_dek
	rows map[orgVer][]byte
}

type orgVer struct {
	org     string
	version int
}

func newFakeDB() *fakeDB { return &fakeDB{rows: map[orgVer][]byte{}} }

func (f *fakeDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	// Only the INSERT path is exercised.
	if strings.Contains(sql, "INSERT INTO org_keys") {
		org := args[0].(string)
		version := args[1].(int)
		wrapped := args[2].([]byte)
		k := orgVer{org, version}
		if _, exists := f.rows[k]; !exists { // ON CONFLICT DO NOTHING
			f.rows[k] = wrapped
		}
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}
	return pgconn.CommandTag{}, nil
}

func (f *fakeDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	switch {
	// SELECT COALESCE(MAX(key_version), 0) FROM org_keys WHERE org_id = $1 —
	// RotateDEK's own query for the next version number. Checked before the
	// "retired_at IS NULL" case below since neither substring is a subset of
	// the other, but this one is more specific to check first for clarity.
	case strings.Contains(sql, "MAX(key_version)"):
		org := args[0].(string)
		maxV := 0
		for k := range f.rows {
			if k.org == org && k.version > maxV {
				maxV = k.version
			}
		}
		return &valuesRow{vals: []any{maxV}}
	// SELECT key_version, wrapped_dek ... retired_at IS NULL ORDER BY ... LIMIT 1
	case strings.Contains(sql, "retired_at IS NULL"):
		org := args[0].(string)
		best := -1
		var wrapped []byte
		for k, w := range f.rows {
			if k.org == org && k.version > best {
				best = k.version
				wrapped = w
			}
		}
		if best < 0 {
			return errRow{pgx.ErrNoRows}
		}
		return &valuesRow{vals: []any{best, wrapped}}
	// SELECT wrapped_dek WHERE org_id = $1 AND key_version = $2
	case strings.Contains(sql, "key_version = $2"):
		org := args[0].(string)
		version := args[1].(int)
		w, ok := f.rows[orgVer{org, version}]
		if !ok {
			return errRow{pgx.ErrNoRows}
		}
		return &valuesRow{vals: []any{w}}
	}
	return errRow{pgx.ErrNoRows}
}

// errRow is a pgx.Row that always returns the wrapped error on Scan.
type errRow struct{ err error }

func (r errRow) Scan(dest ...any) error { return r.err }

// valuesRow assigns positional values into the Scan destinations. Supports the
// (int, []byte) and ([]byte) shapes the Cryptor scans.
type valuesRow struct{ vals []any }

func (r *valuesRow) Scan(dest ...any) error {
	for i, d := range dest {
		switch p := d.(type) {
		case *int:
			*p = r.vals[i].(int)
		case *[]byte:
			*p = append([]byte(nil), r.vals[i].([]byte)...)
		default:
			panic("valuesRow: unsupported scan dest")
		}
	}
	return nil
}

func newTestCryptor(t *testing.T) *Cryptor {
	t.Helper()
	kek, err := NewDevKEKProvider("test-passphrase", []byte("0123456789abcdef-salt"), 1)
	if err != nil {
		t.Fatalf("NewDevKEKProvider: %v", err)
	}
	return New(kek, time.Minute)
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()
	const org = "org-aaa"

	cases := []string{"", "hello world", "unicode ☃ é 漢字", strings.Repeat("x", 4096)}
	for _, pt := range cases {
		blob, err := c.Encrypt(ctx, db, org, pt)
		if err != nil {
			t.Fatalf("Encrypt(%q): %v", pt, err)
		}
		// Self-describing header: fmt byte 0x01 + version 0x0001.
		if len(blob) < headerLen+nonceLen || blob[0] != fmtV1 {
			t.Fatalf("bad ciphertext header for %q: % x", pt, blob[:min(headerLen, len(blob))])
		}
		got, err := c.Decrypt(ctx, db, org, blob)
		if err != nil {
			t.Fatalf("Decrypt(%q): %v", pt, err)
		}
		if got != pt {
			t.Fatalf("round-trip mismatch: got %q want %q", got, pt)
		}
	}

	// The DEK was created lazily on first Encrypt — exactly one org_keys row.
	if len(db.rows) != 1 {
		t.Fatalf("expected 1 org_keys row, got %d", len(db.rows))
	}
}

func TestDecryptWrongOrgFailsClosed(t *testing.T) {
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()

	blob, err := c.Encrypt(ctx, db, "org-aaa", "secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	// org_id is the AES-GCM AAD, so decrypting under a different org must fail
	// (after that org lazily mints its own DEK).
	if _, err := c.Decrypt(ctx, db, "org-bbb", blob); err == nil {
		t.Fatal("expected decrypt under wrong org to fail, got nil")
	}
}

func TestDecryptTamperedCiphertextFailsClosed(t *testing.T) {
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()

	blob, err := c.Encrypt(ctx, db, "org-aaa", "secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	tampered := append([]byte(nil), blob...)
	tampered[len(tampered)-1] ^= 0xFF // flip a bit in the GCM tag
	if _, err := c.Decrypt(ctx, db, "org-aaa", tampered); err == nil {
		t.Fatal("expected decrypt of tampered ciphertext to fail, got nil")
	}
}

// Phase 11: PeekVersion / WarmVersions / DecryptCached — the batch-decrypt
// split ListChannels/ListConversations use to release the pooled connection
// before the CPU-bound decrypt loop. See the "Batch decrypt" section comment
// in crypto.go for why this exists.

func TestPeekVersionReadsTheEmbeddedVersionWithoutDecrypting(t *testing.T) {
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()

	blob, err := c.Encrypt(ctx, db, "org-aaa", "hello")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	v, ok := c.PeekVersion(blob)
	if !ok || v != 1 {
		t.Fatalf("PeekVersion = (%d, %v), want (1, true)", v, ok)
	}
	if _, ok := c.PeekVersion(nil); ok {
		t.Fatal("PeekVersion(nil) reported ok=true, want false")
	}
	if _, ok := c.PeekVersion([]byte{0x01, 0x00}); ok {
		t.Fatal("PeekVersion of a too-short blob reported ok=true, want false")
	}
}

func TestDecryptCachedRoundTripsAWarmBatch(t *testing.T) {
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()
	const org = "org-aaa"

	blobs := make([][]byte, 3)
	for i, pt := range []string{"first", "second", "third"} {
		blob, err := c.Encrypt(ctx, db, org, pt)
		if err != nil {
			t.Fatalf("Encrypt(%q): %v", pt, err)
		}
		blobs[i] = blob
	}

	versions := map[int]struct{}{}
	for _, b := range blobs {
		v, ok := c.PeekVersion(b)
		if !ok {
			t.Fatal("PeekVersion unexpectedly reported ok=false")
		}
		versions[v] = struct{}{}
	}
	if err := c.WarmVersions(ctx, db, org, versions); err != nil {
		t.Fatalf("WarmVersions: %v", err)
	}

	want := []string{"first", "second", "third"}
	for i, blob := range blobs {
		got, err := c.DecryptCached(org, blob)
		if err != nil {
			t.Fatalf("DecryptCached[%d]: %v", i, err)
		}
		if got != want[i] {
			t.Fatalf("DecryptCached[%d] = %q, want %q", i, got, want[i])
		}
	}
}

func TestDecryptCachedResolvesEachBlobAgainstItsOwnVersion(t *testing.T) {
	// A batch spanning a DEK rotation must decrypt each item under the
	// key_version embedded in THAT item, not just whichever was warmed last —
	// this is the exact scenario ListChannels/ListConversations hit when a
	// rotation happens between two rows in the same result set.
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()
	const org = "org-aaa"

	oldBlob, err := c.Encrypt(ctx, db, org, "old")
	if err != nil {
		t.Fatalf("Encrypt(old): %v", err)
	}
	if _, _, err := c.RotateDEK(ctx, db, org); err != nil {
		t.Fatalf("RotateDEK: %v", err)
	}
	newBlob, err := c.Encrypt(ctx, db, org, "new")
	if err != nil {
		t.Fatalf("Encrypt(new): %v", err)
	}

	versions := map[int]struct{}{}
	for _, b := range [][]byte{oldBlob, newBlob} {
		v, _ := c.PeekVersion(b)
		versions[v] = struct{}{}
	}
	if len(versions) != 2 {
		t.Fatalf("expected the batch to span 2 DEK versions, got %d", len(versions))
	}
	if err := c.WarmVersions(ctx, db, org, versions); err != nil {
		t.Fatalf("WarmVersions: %v", err)
	}

	gotOld, err := c.DecryptCached(org, oldBlob)
	if err != nil {
		t.Fatalf("DecryptCached(old): %v", err)
	}
	if gotOld != "old" {
		t.Fatalf("DecryptCached(old) = %q, want %q", gotOld, "old")
	}
	gotNew, err := c.DecryptCached(org, newBlob)
	if err != nil {
		t.Fatalf("DecryptCached(new): %v", err)
	}
	if gotNew != "new" {
		t.Fatalf("DecryptCached(new) = %q, want %q", gotNew, "new")
	}
}

func TestDecryptCachedFailsClosedOnAColdVersion(t *testing.T) {
	// The entire point of the peek/warm/decrypt split is that DecryptCached
	// NEVER reaches for the database — a version nobody warmed must return an
	// error, not silently fetch it (which would put the connection-hold
	// problem right back in place).
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()

	blob, err := c.Encrypt(ctx, db, "org-aaa", "never warmed")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	// A fresh Cryptor with the same KEK — same DEK, empty cache.
	cold := New(c.kek, time.Minute)
	if _, err := cold.DecryptCached("org-aaa", blob); err == nil {
		t.Fatal("expected DecryptCached to fail closed on a cold cache, got nil")
	}
}

func TestDecryptCachedFailsClosedOnTamperedCiphertext(t *testing.T) {
	ctx := context.Background()
	c := newTestCryptor(t)
	db := newFakeDB()
	const org = "org-aaa"

	blob, err := c.Encrypt(ctx, db, org, "hello")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	v, _ := c.PeekVersion(blob)
	if err := c.WarmVersions(ctx, db, org, map[int]struct{}{v: {}}); err != nil {
		t.Fatalf("WarmVersions: %v", err)
	}
	tampered := append([]byte(nil), blob...)
	tampered[len(tampered)-1] ^= 0xFF
	if _, err := c.DecryptCached(org, tampered); err == nil {
		t.Fatal("expected DecryptCached of tampered ciphertext to fail, got nil")
	}
}

func TestDevKEKWrapUnwrapRoundTrip(t *testing.T) {
	kek, err := NewDevKEKProvider("pp", []byte("0123456789abcdef"), 2)
	if err != nil {
		t.Fatalf("NewDevKEKProvider: %v", err)
	}
	dek := bytes.Repeat([]byte{0xAB}, dekLen)
	wrapped, ver, err := kek.Wrap("org-x", dek)
	if err != nil {
		t.Fatalf("Wrap: %v", err)
	}
	if ver != 2 {
		t.Fatalf("version = %d, want 2", ver)
	}
	got, err := kek.Unwrap("org-x", wrapped, ver)
	if err != nil {
		t.Fatalf("Unwrap: %v", err)
	}
	if !bytes.Equal(got, dek) {
		t.Fatal("unwrapped DEK != original")
	}
	// Wrong org AAD must fail closed.
	if _, err := kek.Unwrap("org-y", wrapped, ver); err == nil {
		t.Fatal("expected unwrap under wrong org to fail")
	}
}

func TestKMSProviderFailsClosed(t *testing.T) {
	// Empty key id -> error.
	if _, err := NewKMSKEKProvider("vault-transit", "", "http://127.0.0.1:8200", "tok", 1); err == nil {
		t.Fatal("expected error when DATA_KMS_KEY_ID is empty")
	}
	// Unwired backend -> error.
	if _, err := NewKMSKEKProvider("aws-kms", "key-123", "http://127.0.0.1:8200", "tok", 1); err == nil {
		t.Fatal("expected error for an unwired KMS backend")
	}
	// vault-transit without addr/token -> error (fail closed).
	if _, err := NewKMSKEKProvider("vault-transit", "key-123", "", "", 1); err == nil {
		t.Fatal("expected error when VAULT_ADDR/VAULT_TOKEN are missing")
	}
	// Constructs with addr+token, but the HTTP calls fail closed against a dead Vault.
	p, err := NewKMSKEKProvider("vault-transit", "key-123", "http://127.0.0.1:1", "tok", 1)
	if err != nil {
		t.Fatalf("NewKMSKEKProvider: %v", err)
	}
	if _, _, err := p.Wrap("org", make([]byte, dekLen)); err == nil {
		t.Fatal("expected Wrap to fail against an unreachable Vault")
	}
	if _, err := p.Unwrap("org", []byte("vault:v1:x"), 1); err == nil {
		t.Fatal("expected Unwrap to fail against an unreachable Vault")
	}
}
