// Package crypto implements application-layer at-rest column encryption
// (server-readable, transparent) for messaging-svc.
//
// The service holds the keys and decrypts in-process, so search / previews /
// notifications / offline-email all keep working — this is NOT client-side E2E.
// It is a faithful Go port of services/auth-svc/app/crypto.py so a row written
// by either service uses an interchangeable ciphertext format.
//
// Design (see the security plan):
//   - AES-256-GCM with a random 96-bit nonce per encryption; AAD = org_id (a row
//     copied into another org won't decrypt).
//   - Envelope encryption: a per-ORG 32-byte Data Encryption Key (DEK), wrapped by
//     a Key Encryption Key (KEK) and stored (wrapped) in the per-service org_keys
//     table. Per-org DEKs enable crypto-shredding (delete the row -> unreadable).
//   - Self-describing ciphertext: 0x01 || key_version(uint16 BE) || nonce(12) ||
//     AES-GCM(ct||tag). Embedding key_version makes DEK rotation lazy.
//   - KEK provider is pluggable: DEV derives the KEK from a passphrase via Argon2id
//     (honoring "use Argon2" as the KDF); PROD wraps DEKs through a KMS. The
//     vault-transit backend is IMPLEMENTED — the master key never leaves Vault —
//     while aws-kms and gcp-kms fail closed at construction. This said "(stub)"
//     long after Vault was wired, which reads as "at-rest key wrapping is fake in
//     production" to anyone auditing it.
package crypto

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	fmtV1     = 0x01
	nonceLen  = 12
	headerLen = 3 // format byte (1) + key_version uint16 BE (2)
)

// Argon2id KDF parameters for the DEV master KEK. Pinned (and mirrored in the
// Python services) so a passphrase deterministically yields the same KEK across
// restarts and languages. DEV/TEST only — prod wraps DEKs via KMS/Vault.
const (
	kdfTimeCost  = 3
	kdfMemoryKiB = 64 * 1024 // 64 MiB
	kdfParallel  = 4
	kdfKeyLen    = 32
	dekLen       = 32
	firstVersion = 1
)

// ErrCrypto is returned on any decrypt/unwrap failure. We fail closed: never
// return plaintext when the integrity/authenticity check fails.
var ErrCrypto = errors.New("crypto error")

func cryptoErrf(format string, a ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrCrypto}, a...)...)
}

// Querier is the subset of pgx used by the Cryptor. Both *pgxpool.Pool and
// pgx.Tx satisfy it, so a read can pass the pool while a write passes its tx —
// letting the org_keys row be created atomically inside the insert's tx.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ── KEK providers ────────────────────────────────────────────────────────────

// KEKProvider wraps/unwraps a per-org DEK. version lets the KEK itself rotate.
type KEKProvider interface {
	Wrap(orgID string, dek []byte) (wrapped []byte, version int, err error)
	Unwrap(orgID string, wrapped []byte, version int) ([]byte, error)
}

// DevKEKProvider is the local/dev KEK: a single master key derived from a
// passphrase via Argon2id. The wrapped DEK is nonce(12) || AES-256-GCM(dek)
// under the master KEK, with AAD = org_id. NOT for production.
type DevKEKProvider struct {
	kek     []byte
	version int
}

// NewDevKEKProvider derives the master KEK from the passphrase + salt.
func NewDevKEKProvider(passphrase string, salt []byte, version int) (*DevKEKProvider, error) {
	if passphrase == "" || len(salt) < 16 {
		return nil, cryptoErrf("DATA_MASTER_PASSPHRASE/SALT not configured")
	}
	if version <= 0 {
		version = firstVersion
	}
	kek := argon2.IDKey([]byte(passphrase), salt, kdfTimeCost, kdfMemoryKiB, kdfParallel, kdfKeyLen)
	return &DevKEKProvider{kek: kek, version: version}, nil
}

// Wrap encrypts dek under the master KEK (AAD = org_id).
func (p *DevKEKProvider) Wrap(orgID string, dek []byte) ([]byte, int, error) {
	gcm, err := newGCM(p.kek)
	if err != nil {
		return nil, 0, err
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, 0, err
	}
	ct := gcm.Seal(nil, nonce, dek, []byte(orgID))
	return append(nonce, ct...), p.version, nil
}

// Unwrap decrypts a wrapped DEK. Fails closed on any tampering/key mismatch.
func (p *DevKEKProvider) Unwrap(orgID string, wrapped []byte, version int) ([]byte, error) {
	if len(wrapped) < nonceLen {
		return nil, cryptoErrf("wrapped DEK too short")
	}
	gcm, err := newGCM(p.kek)
	if err != nil {
		return nil, err
	}
	nonce, ct := wrapped[:nonceLen], wrapped[nonceLen:]
	dek, err := gcm.Open(nil, nonce, ct, []byte(orgID))
	if err != nil {
		return nil, cryptoErrf("DEK unwrap failed")
	}
	return dek, nil
}

// KMSKEKProvider wraps DEKs via an external KMS. backend "vault-transit" is
// WIRED (HashiCorp Vault Transit — the master key never leaves Vault); aws-kms /
// gcp-kms fail closed until implemented. The wrapped DEK we store is Vault's
// self-describing "vault:vN:..." ciphertext, so a Vault-side KEK rotation is
// transparent on decrypt. The HTTP call is blocking, but the per-org DEK cache
// means it runs only on a cache miss / rotation, not per query.
type KMSKEKProvider struct {
	backend string
	keyID   string
	addr    string
	token   string
	version int
	client  *http.Client
}

// NewKMSKEKProvider validates config and wires the Vault Transit backend.
func NewKMSKEKProvider(backend, keyID, vaultAddr, vaultToken string, version int) (*KMSKEKProvider, error) {
	if keyID == "" {
		return nil, cryptoErrf("DATA_KMS_KEY_ID must be set when DATA_KEK_PROVIDER=kms")
	}
	if backend != "vault-transit" {
		return nil, cryptoErrf("KMS backend %q not wired — use vault-transit (or implement aws-kms/gcp-kms)", backend)
	}
	if vaultAddr == "" || vaultToken == "" {
		return nil, cryptoErrf("VAULT_ADDR and VAULT_TOKEN are required for vault-transit")
	}
	if version <= 0 {
		version = firstVersion
	}
	return &KMSKEKProvider{
		backend: backend,
		keyID:   keyID,
		addr:    strings.TrimRight(vaultAddr, "/"),
		token:   vaultToken,
		version: version,
		client:  &http.Client{Timeout: 5 * time.Second},
	}, nil
}

func (p *KMSKEKProvider) transit(op string, payload map[string]string) (map[string]any, error) {
	body, _ := json.Marshal(payload)
	// The KEKProvider interface carries no context, so the cancellation bound
	// is p.client's 5s timeout. Saying that explicitly beats http.NewRequest,
	// which leaves a reader unsure whether the omission was deliberate.
	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost, p.addr+"/v1/transit/"+op+"/"+p.keyID, bytes.NewReader(body),
	)
	if err != nil {
		return nil, cryptoErrf("vault request build failed")
	}
	req.Header.Set("X-Vault-Token", p.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, cryptoErrf("vault transit/%s failed", op)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, cryptoErrf("vault transit/%s status %d", op, resp.StatusCode)
	}
	var out struct {
		Data map[string]any `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, cryptoErrf("vault transit/%s decode failed", op)
	}
	return out.Data, nil
}

// Wrap encrypts the DEK via Vault Transit; returns Vault's ciphertext string bytes.
func (p *KMSKEKProvider) Wrap(orgID string, dek []byte) ([]byte, int, error) {
	data, err := p.transit("encrypt", map[string]string{"plaintext": base64.StdEncoding.EncodeToString(dek)})
	if err != nil {
		return nil, 0, err
	}
	ct, _ := data["ciphertext"].(string)
	if ct == "" {
		return nil, 0, cryptoErrf("vault encrypt: no ciphertext")
	}
	return []byte(ct), p.version, nil
}

// Unwrap decrypts a Vault Transit ciphertext back to the DEK. Fails closed.
func (p *KMSKEKProvider) Unwrap(orgID string, wrapped []byte, version int) ([]byte, error) {
	data, err := p.transit("decrypt", map[string]string{"ciphertext": string(wrapped)})
	if err != nil {
		return nil, err
	}
	b64, _ := data["plaintext"].(string)
	dek, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, cryptoErrf("vault decrypt: bad plaintext")
	}
	return dek, nil
}

// ── Cryptor ──────────────────────────────────────────────────────────────────

type dekEntry struct {
	dek     []byte
	expires time.Time
}

type currentEntry struct {
	dek     []byte
	version int
	expires time.Time
}

// Cryptor is a transparent column encryptor. Its methods take the active DB
// Querier (pool for reads, tx for writes) so the per-org DEK can be
// loaded/created from org_keys (cached after first use).
type Cryptor struct {
	kek KEKProvider
	ttl time.Duration

	mu      sync.RWMutex
	current map[string]currentEntry // org -> current (newest) DEK
	byVer   map[dekKey]dekEntry     // (org, version) -> DEK
	locks   map[string]*sync.Mutex  // per-org single-flight lock
	locksMu sync.Mutex
}

type dekKey struct {
	org     string
	version int
}

// New constructs a Cryptor with the given KEK provider and DEK cache TTL.
func New(kek KEKProvider, cacheTTL time.Duration) *Cryptor {
	if cacheTTL <= 0 {
		cacheTTL = 300 * time.Second
	}
	return &Cryptor{
		kek:     kek,
		ttl:     cacheTTL,
		current: make(map[string]currentEntry),
		byVer:   make(map[dekKey]dekEntry),
		locks:   make(map[string]*sync.Mutex),
	}
}

// Encrypt returns the self-describing ciphertext for plaintext under the org's
// current DEK. q must be the same tx as the surrounding write so a freshly
// generated org_keys row is created atomically.
func (c *Cryptor) Encrypt(ctx context.Context, q Querier, orgID, plaintext string) ([]byte, error) {
	dek, version, err := c.currentDEK(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(dek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ct := gcm.Seal(nil, nonce, []byte(plaintext), []byte(orgID))

	// The header stores the key version in two bytes. A larger version would
	// wrap silently and stamp the WRONG version into the ciphertext, so every
	// later decrypt would reach for a key that never encrypted it. Refuse
	// instead — this is unreachable today (versions are small integers from
	// config) and cheap to keep unreachable.
	if version < 0 || version > math.MaxUint16 {
		return nil, cryptoErrf("key version %d does not fit the ciphertext header", version)
	}
	out := make([]byte, 0, headerLen+nonceLen+len(ct))
	out = append(out, fmtV1)
	out = binary.BigEndian.AppendUint16(out, uint16(version))
	out = append(out, nonce...)
	out = append(out, ct...)
	return out, nil
}

// Decrypt reverses Encrypt. The key_version is read from the blob header so a
// row written under an older (rotated) DEK still decrypts. Fails closed.
func (c *Cryptor) Decrypt(ctx context.Context, q Querier, orgID string, blob []byte) (string, error) {
	if len(blob) < headerLen+nonceLen {
		return "", cryptoErrf("ciphertext too short")
	}
	if blob[0] != fmtV1 {
		return "", cryptoErrf("unknown ciphertext format %d", blob[0])
	}
	version := int(binary.BigEndian.Uint16(blob[1:headerLen]))
	nonce := blob[headerLen : headerLen+nonceLen]
	ct := blob[headerLen+nonceLen:]

	dek, err := c.dekForVersion(ctx, q, orgID, version)
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(dek)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, nonce, ct, []byte(orgID))
	if err != nil {
		return "", cryptoErrf("decrypt failed")
	}
	return string(pt), nil
}

// ── DEK management (org_keys) ────────────────────────────────────────────────

func (c *Cryptor) orgLock(orgID string) *sync.Mutex {
	c.locksMu.Lock()
	defer c.locksMu.Unlock()
	lk := c.locks[orgID]
	if lk == nil {
		lk = &sync.Mutex{}
		c.locks[orgID] = lk
	}
	return lk
}

// currentDEK returns the org's newest (non-retired) DEK, generating one on
// first use. Single-flight per org so a cold cache can't stampede org_keys.
func (c *Cryptor) currentDEK(ctx context.Context, q Querier, orgID string) ([]byte, int, error) {
	now := time.Now()
	c.mu.RLock()
	cur, ok := c.current[orgID]
	c.mu.RUnlock()
	if ok && cur.expires.After(now) {
		return cur.dek, cur.version, nil
	}

	lk := c.orgLock(orgID)
	lk.Lock()
	defer lk.Unlock()

	// Re-check under the per-org lock (another goroutine may have filled it).
	c.mu.RLock()
	cur, ok = c.current[orgID]
	c.mu.RUnlock()
	if ok && cur.expires.After(time.Now()) {
		return cur.dek, cur.version, nil
	}

	var (
		version int
		wrapped []byte
		dek     []byte
		err     error
	)
	row := q.QueryRow(ctx,
		`SELECT key_version, wrapped_dek FROM org_keys
		 WHERE org_id = $1 AND retired_at IS NULL
		 ORDER BY key_version DESC LIMIT 1`, orgID)
	if scanErr := row.Scan(&version, &wrapped); scanErr != nil {
		if errors.Is(scanErr, pgx.ErrNoRows) {
			dek, version, err = c.generateDEK(ctx, q, orgID)
			if err != nil {
				return nil, 0, err
			}
		} else {
			return nil, 0, scanErr
		}
	} else {
		dek, err = c.kek.Unwrap(orgID, wrapped, version)
		if err != nil {
			return nil, 0, err
		}
	}

	c.store(orgID, version, dek)
	return dek, version, nil
}

// dekForVersion fetches a specific (org, version) DEK, used on decrypt so a
// rotated-away version still resolves while its row remains in org_keys.
func (c *Cryptor) dekForVersion(ctx context.Context, q Querier, orgID string, version int) ([]byte, error) {
	now := time.Now()
	c.mu.RLock()
	hit, ok := c.byVer[dekKey{orgID, version}]
	c.mu.RUnlock()
	if ok && hit.expires.After(now) {
		return hit.dek, nil
	}

	var wrapped []byte
	row := q.QueryRow(ctx,
		`SELECT wrapped_dek FROM org_keys WHERE org_id = $1 AND key_version = $2`,
		orgID, version)
	if err := row.Scan(&wrapped); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, cryptoErrf("no DEK for org %s version %d (crypto-shredded?)", orgID, version)
		}
		return nil, err
	}
	dek, err := c.kek.Unwrap(orgID, wrapped, version)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.byVer[dekKey{orgID, version}] = dekEntry{dek: dek, expires: time.Now().Add(c.ttl)}
	c.mu.Unlock()
	return dek, nil
}

// generateDEK creates the org's first DEK lazily, wraps it, and inserts the
// org_keys row inside the caller's tx (ON CONFLICT DO NOTHING for races). It
// re-reads to win any concurrent insert; if our own INSERT is still in-flight
// in the same tx, the SELECT inside that tx sees it.
func (c *Cryptor) generateDEK(ctx context.Context, q Querier, orgID string) ([]byte, int, error) {
	dek := make([]byte, dekLen)
	if _, err := rand.Read(dek); err != nil {
		return nil, 0, err
	}
	version := firstVersion
	wrapped, _, err := c.kek.Wrap(orgID, dek)
	if err != nil {
		return nil, 0, err
	}
	if _, err := q.Exec(ctx,
		`INSERT INTO org_keys (org_id, key_version, wrapped_dek)
		 VALUES ($1, $2, $3) ON CONFLICT (org_id, key_version) DO NOTHING`,
		orgID, version, wrapped); err != nil {
		return nil, 0, err
	}

	// Re-read to win any race: another tx may hold the canonical row.
	var canonical []byte
	row := q.QueryRow(ctx,
		`SELECT wrapped_dek FROM org_keys WHERE org_id = $1 AND key_version = $2`,
		orgID, version)
	if scanErr := row.Scan(&canonical); scanErr != nil {
		if errors.Is(scanErr, pgx.ErrNoRows) {
			return dek, version, nil // our INSERT is in-flight in this same tx
		}
		return nil, 0, scanErr
	}
	unwrapped, err := c.kek.Unwrap(orgID, canonical, version)
	if err != nil {
		return nil, 0, err
	}
	return unwrapped, version, nil
}

func (c *Cryptor) store(orgID string, version int, dek []byte) {
	exp := time.Now().Add(c.ttl)
	c.mu.Lock()
	c.current[orgID] = currentEntry{dek: dek, version: version, expires: exp}
	c.byVer[dekKey{orgID, version}] = dekEntry{dek: dek, expires: exp}
	c.mu.Unlock()
}

// RotateDEK rotates the org's DEK: creates a new generation and retires the
// current one. Rotation is LAZY — existing ciphertext keeps decrypting via its
// embedded key_version (old DEK rows are retained, just marked retired); only NEW
// writes use the new DEK. q must be a tx with app.org_id set (org_keys is RLS).
// Returns (oldVersion, newVersion).
func (c *Cryptor) RotateDEK(ctx context.Context, q Querier, orgID string) (int, int, error) {
	lk := c.orgLock(orgID)
	lk.Lock()
	defer lk.Unlock()

	var oldVersion int
	if err := q.QueryRow(ctx,
		`SELECT key_version FROM org_keys WHERE org_id = $1 AND retired_at IS NULL
		 ORDER BY key_version DESC LIMIT 1`, orgID).Scan(&oldVersion); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, err
	}
	var maxV int
	if err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(key_version), 0) FROM org_keys WHERE org_id = $1`, orgID).Scan(&maxV); err != nil {
		return 0, 0, err
	}
	newVersion := maxV + 1
	newDEK := make([]byte, dekLen)
	if _, err := rand.Read(newDEK); err != nil {
		return 0, 0, err
	}
	wrapped, _, err := c.kek.Wrap(orgID, newDEK)
	if err != nil {
		return 0, 0, err
	}
	if _, err := q.Exec(ctx,
		`INSERT INTO org_keys (org_id, key_version, wrapped_dek) VALUES ($1, $2, $3)`,
		orgID, newVersion, wrapped); err != nil {
		return 0, 0, err
	}
	if oldVersion > 0 {
		if _, err := q.Exec(ctx,
			`UPDATE org_keys SET retired_at = now()
			 WHERE org_id = $1 AND key_version = $2 AND retired_at IS NULL`,
			orgID, oldVersion); err != nil {
			return 0, 0, err
		}
	}
	// Bust cache so the next encrypt picks up the new generation.
	c.mu.Lock()
	delete(c.current, orgID)
	c.byVer[dekKey{orgID, newVersion}] = dekEntry{dek: newDEK, expires: time.Now().Add(c.ttl)}
	c.mu.Unlock()
	return oldVersion, newVersion, nil
}

// ── construction from config ─────────────────────────────────────────────────

// Settings is the minimal config the Cryptor needs, decoupled from the config
// package so crypto stays import-light. cmd/server adapts config.DataConfig.
type Settings struct {
	KEKProvider       string
	MasterPassphrase  string
	MasterSalt        string
	KEKVersion        int
	DEKCacheTTLSecond float64
	KMSBackend        string
	KMSKeyID          string
	VaultAddr         string
	VaultToken        string
}

// Build constructs the Cryptor from settings (called once at startup). It
// fails closed: a misconfigured KMS provider returns an error rather than
// silently falling back to the dev KEK.
func Build(s Settings) (*Cryptor, error) {
	var (
		kek KEKProvider
		err error
	)
	if s.KEKProvider == "kms" {
		kek, err = NewKMSKEKProvider(s.KMSBackend, s.KMSKeyID, s.VaultAddr, s.VaultToken, s.KEKVersion)
	} else {
		kek, err = NewDevKEKProvider(s.MasterPassphrase, []byte(s.MasterSalt), s.KEKVersion)
	}
	if err != nil {
		return nil, err
	}
	ttl := time.Duration(s.DEKCacheTTLSecond * float64(time.Second))
	return New(kek, ttl), nil
}

// ── low-level helpers ────────────────────────────────────────────────────────

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
