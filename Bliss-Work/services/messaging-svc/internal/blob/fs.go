// Package blob is the on-disk, content-addressed store for chat attachments.
//
// Bytes live on a local volume rather than an object store: this deployment has
// no S3/MinIO, and a Docker named volume mounted into an otherwise read-only
// container is the smallest thing that persists. The layout under root is:
//
//	tmp/                                   ← upload spool (same FS ⇒ atomic rename)
//	blobs/{orgID}/{sha[0:2]}/{sha[2:4]}/{sha}
//	maps/{kind}/{key[0:2]}/{key}           ← static-map cache
//
// ── Why shard by org, not globally ───────────────────────────────────────────
// A globally content-addressed store is a content-confirmation oracle: upload
// bytes you merely SUSPECT another org holds, observe that the write deduped,
// and you've confirmed they hold exactly those bytes. Sharding by org kills
// that, makes "delete everything for org X" a single subtree removal, and only
// costs cross-org dedupe — which is not where dedupe pays anyway.
//
// ── Why the spool is here and not os.TempDir() ───────────────────────────────
// Production mounts a tmpfs (RAM-backed) at /tmp inside a memory-capped
// container. Spooling a 100 MB upload there OOM-kills the service. Keeping the
// spool on the same filesystem as the final destination ALSO makes the closing
// os.Rename atomic, so a torn upload can never be observed as a complete blob.
//
// ── Path traversal ───────────────────────────────────────────────────────────
// orgID and sha are the ONLY caller-supplied path components. Both are
// validated (UUID / 64 lowercase hex) before any join. That validation is the
// security boundary of this package; see blob_test.go.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrTooLarge is returned by WriteStream / CachePut when the reader yields more
// than the caller's limit. The partial spool file is removed before returning.
var ErrTooLarge = errors.New("blob: exceeds max size")

// ErrBadKey is returned when an orgID or sha256 fails validation. It is
// deliberately distinct from a not-found so callers can log it as an attack
// signal rather than a miss.
var ErrBadKey = errors.New("blob: invalid key")

// shaRe matches a lowercase hex SHA-256. Anchored, fixed length: no separators,
// no "..", no absolute paths can satisfy it.
var shaRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Store is a handle on the blob root. Safe for concurrent use: every mutation
// goes through create-temp + rename, and the directory creation is idempotent.
type FSStore struct {
	root string
}

// New prepares the blob root and verifies it is writable, failing fast at boot
// rather than on the first user upload. Directories are 0700 — the bytes are
// not application-layer encrypted (see the package docs on streaming/Range), so
// filesystem permissions are load-bearing.
func NewFS(root string) (*FSStore, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("blob: root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("blob: resolve root: %w", err)
	}
	for _, d := range []string{"tmp", "blobs", "maps"} {
		if err := os.MkdirAll(filepath.Join(abs, d), 0o700); err != nil {
			return nil, fmt.Errorf("blob: mkdir %s: %w", d, err)
		}
	}
	// Prove writability now. A read-only or wrongly-owned volume mount is a
	// deployment error we want surfaced at startup, not at 3am on an upload.
	probe, err := os.CreateTemp(filepath.Join(abs, "tmp"), "probe-*")
	if err != nil {
		return nil, fmt.Errorf("blob: root not writable: %w", err)
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)

	return &FSStore{root: abs}, nil
}

// Root returns the absolute blob root (used by operational tooling).
func (s *FSStore) Root() string { return s.root }

// blobPath validates and joins. This is the one place caller input becomes a
// filesystem path, so both components are checked here and nowhere else.
func (s *FSStore) blobPath(orgID, sha string) (string, error) {
	if _, err := uuid.Parse(orgID); err != nil {
		return "", ErrBadKey
	}
	if !shaRe.MatchString(sha) {
		return "", ErrBadKey
	}
	return filepath.Join(s.root, "blobs", orgID, sha[0:2], sha[2:4], sha), nil
}

// RemoveOrg deletes every blob belonging to one organization.
//
// This is the payoff for sharding the tree by org: "delete everything for org
// X" is a single subtree removal rather than a walk. It exists for org
// deletion, where it is the ONLY thing that reaches the attachment bytes —
// crypto-shred does nothing for them, because blob contents are not
// application-encrypted (filesystem permissions are load-bearing here).
//
// The orgID is parsed as a UUID before it touches a path, for the same reason
// blobPath does it: this turns caller input into an os.RemoveAll target, and
// that is not a place to trust a string. A missing directory is success — the
// org may simply never have had an attachment.
func (s *FSStore) RemoveOrg(orgID string) error {
	if _, err := uuid.Parse(orgID); err != nil {
		return ErrBadKey
	}
	return os.RemoveAll(filepath.Join(s.root, "blobs", orgID))
}

// RelPath is the stored storage_path — relative to the root, so the root can be
// remounted elsewhere without rewriting the database.
func (s *FSStore) RelPath(orgID, sha string) (string, error) {
	abs, err := s.blobPath(orgID, sha)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(s.root, abs)
	if err != nil {
		return "", ErrBadKey
	}
	return rel, nil
}

// WriteStream streams r to disk, hashing as it goes, and returns the content
// address. It never buffers the payload in memory.
//
// max is a hard cap: the reader is limited to max+1 bytes so that a payload of
// exactly max succeeds and anything larger is detected without reading the rest
// of the (possibly unbounded) stream.
//
// If a blob with the same content already exists for this org, the spool is
// discarded and the existing path is reused — an idempotent re-upload and a
// genuine duplicate cost one write and then zero.
func (s *FSStore) WriteStream(orgID string, r io.Reader, max int64) (sha string, n int64, err error) {
	if _, perr := uuid.Parse(orgID); perr != nil {
		return "", 0, ErrBadKey
	}
	if max <= 0 {
		return "", 0, errors.New("blob: max must be positive")
	}

	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "up-*.part")
	if err != nil {
		return "", 0, fmt.Errorf("blob: spool: %w", err)
	}
	tmpName := tmp.Name()
	// Any early return past this point must leave nothing behind. On the happy
	// path cleanup is disarmed by clearing tmpName after the rename.
	defer func() {
		_ = tmp.Close()
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	h := sha256.New()
	n, err = io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, max+1))
	if err != nil {
		return "", 0, fmt.Errorf("blob: write: %w", err)
	}
	if n > max {
		return "", 0, ErrTooLarge
	}
	// fsync before the rename: a rename is atomic with respect to the directory
	// entry, but without the sync a crash can leave the entry pointing at a
	// file whose contents never reached the platter.
	if err := tmp.Sync(); err != nil {
		return "", 0, fmt.Errorf("blob: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", 0, fmt.Errorf("blob: close: %w", err)
	}

	sha = hex.EncodeToString(h.Sum(nil))
	dst, err := s.blobPath(orgID, sha)
	if err != nil {
		return "", 0, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", 0, fmt.Errorf("blob: mkdir shard: %w", err)
	}

	// Dedupe: identical content already stored for this org. Keep the original
	// (its mtime drives download caching) and drop the spool.
	if fi, statErr := os.Stat(dst); statErr == nil && fi.Size() == n {
		return sha, n, nil
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return "", 0, fmt.Errorf("blob: commit: %w", err)
	}
	tmpName = "" // disarm cleanup; the file now belongs to the store
	return sha, n, nil
}

// Open returns the blob for reading, seekable so the download handler can hand
// it to http.ServeContent for Range/If-Modified-Since support. The caller owns
// closing it.
func (s *FSStore) Open(orgID, sha string) (Reader, error) {
	p, err := s.blobPath(orgID, sha)
	if err != nil {
		return nil, err
	}
	return openFile(p)
}

// OpenKey serves a key this package produced (RecordingKey). The key is
// re-validated here rather than trusted: it arrives from a database column and
// is about to become a path under the blob root, which is exactly the input
// blobPath refuses to take on faith.
func (s *FSStore) OpenKey(key string) (Reader, error) {
	if err := ParseRecordingKey(key); err != nil {
		return nil, err
	}
	return openFile(filepath.Join(s.root, filepath.FromSlash(key)))
}

// fsReader adapts an *os.File to Reader. The size and mod time are captured at
// open rather than read lazily: ServeContent asks for both while streaming, and
// a Stat per call on a hot download path is a syscall for something that cannot
// change (blobs are content-addressed and never rewritten).
type fsReader struct {
	*os.File
	size    int64
	modTime time.Time
}

func (r *fsReader) Size() int64        { return r.size }
func (r *fsReader) ModTime() time.Time { return r.modTime }

func openFile(p string) (Reader, error) {
	f, err := os.Open(p) //nolint:gosec // G304: p comes from blobPath/cachePath, both validated
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return &fsReader{File: f, size: fi.Size(), modTime: fi.ModTime()}, nil
}

// Remove deletes a blob. A missing file is not an error: the reaper races with
// nothing in particular, and "already gone" is the desired end state.
func (s *FSStore) Remove(orgID, sha string) error {
	p, err := s.blobPath(orgID, sha)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ── derived-content cache (static maps) ──────────────────────────────────────
//
// Cache entries are not user uploads: the key is a hash the SERVER computes
// from validated numeric parameters, so it needs no org scoping and cannot be
// steered by a client.

var cacheKeyRe = regexp.MustCompile(`^[0-9a-f]{16,64}$`)

// cacheKindRe is an ALLOWLIST of derived-content namespaces, not a sanitiser.
//
// This used to be a literal `kind != "maps"`, which silently broke the reverse-
// geocode cache the moment it was added: geocode.go asks for kind "geocode",
// got ErrBadKey on every get AND every put, and — because both call sites treat
// a cache miss as normal and ignore the error — degraded to calling the
// geocoding provider on every single shared location, billed per request, with
// nothing in any log to say so.
//
// Anchored and character-restricted so a kind can never contribute a path
// separator or a "..". Adding a namespace is deliberately a code change.
var cacheKindRe = regexp.MustCompile(`^(maps|geocode)$`)

func (s *FSStore) cachePath(kind, key string) (string, error) {
	if !cacheKindRe.MatchString(kind) || !cacheKeyRe.MatchString(key) {
		return "", ErrBadKey
	}
	return filepath.Join(s.root, "maps", kind, key[0:2], key), nil
}

// CacheGet returns a cached derived asset, or an error if absent.
func (s *FSStore) CacheGet(kind, key string) (Reader, error) {
	p, err := s.cachePath(kind, key)
	if err != nil {
		return nil, err
	}
	return openFile(p)
}

// CachePut stores a derived asset under key, capped at max bytes.
func (s *FSStore) CachePut(kind, key string, r io.Reader, max int64) error {
	p, err := s.cachePath(kind, key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "cache-*.part")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	n, err := io.Copy(tmp, io.LimitReader(r, max+1))
	if err != nil {
		return err
	}
	if n > max {
		return ErrTooLarge
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, p); err != nil {
		return err
	}
	tmpName = ""
	return nil
}
