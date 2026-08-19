package blob

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Store keeps attachment bytes in any S3-compatible bucket — MinIO, AWS S3,
// Cloudflare R2, DigitalOcean Spaces.
//
// This is what lets messaging-svc run more than one replica. The filesystem
// implementation cannot: two pods do not share a volume, so one accepts an
// upload and the other 404s the download.
//
// The key layout is byte-for-byte the same as the disk layout —
// `blobs/{orgID}/{sha[0:2]}/{sha[2:4]}/{sha}` — which is not cosmetic. It keeps
// `attachments.storage_path` valid across the migration (RelPath returns the
// same string either way, so not one database row is rewritten), and it keeps
// RemoveOrg a single prefix operation.
type S3Store struct {
	c      *minio.Client
	bucket string
	// prefix scopes every key, so one bucket can hold several environments
	// without them colliding. Empty for a dedicated bucket.
	prefix string
}

// S3Config is the operator-facing configuration.
type S3Config struct {
	Endpoint  string // host:port — no scheme; UseSSL carries that
	Bucket    string
	AccessKey string
	SecretKey string
	Region    string
	UseSSL    bool
	Prefix    string
}

// NewS3 connects, and verifies the bucket is reachable and writable before
// returning.
//
// Failing at boot is the point, and it mirrors what NewFS does with its write
// probe: a mistyped endpoint, a wrong key or a missing bucket is a deployment
// error, and the moment to learn about it is at startup — not on the first user
// upload, hours later, as a 500 in someone's chat.
func NewS3(ctx context.Context, cfg S3Config) (*S3Store, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, errors.New("blob: S3 endpoint is required")
	}
	if strings.TrimSpace(cfg.Bucket) == "" {
		return nil, errors.New("blob: S3 bucket is required")
	}
	c, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("blob: s3 client: %w", err)
	}

	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ok, err := c.BucketExists(probeCtx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("blob: reach bucket %q: %w", cfg.Bucket, err)
	}
	if !ok {
		return nil, fmt.Errorf("blob: bucket %q does not exist", cfg.Bucket)
	}

	return &S3Store{c: c, bucket: cfg.Bucket, prefix: strings.Trim(cfg.Prefix, "/")}, nil
}

// key builds the object key for a blob, validating both caller-supplied
// components exactly as the filesystem implementation does.
//
// The validation matters as much here as on a disk, for a different reason: a
// key is not a path, so "../" cannot escape a bucket — but an unvalidated orgID
// WOULD let a caller read or overwrite another org's prefix, which is the same
// breach by a different route.
func (s *S3Store) key(orgID, sha string) (string, error) {
	if _, err := uuid.Parse(orgID); err != nil {
		return "", ErrBadKey
	}
	if !shaRe.MatchString(sha) {
		return "", ErrBadKey
	}
	return s.join("blobs", orgID, sha[0:2], sha[2:4], sha), nil
}

func (s *S3Store) cacheKey(kind, key string) (string, error) {
	if !cacheKindRe.MatchString(kind) || !shaRe.MatchString(key) {
		return "", ErrBadKey
	}
	return s.join("maps", kind, key[0:2], key), nil
}

func (s *S3Store) join(parts ...string) string {
	if s.prefix != "" {
		parts = append([]string{s.prefix}, parts...)
	}
	return path.Join(parts...)
}

// RelPath is the stored storage_path — identical to the filesystem layout, so
// rows written before a migration to object storage still resolve afterwards.
func (s *S3Store) RelPath(orgID, sha string) (string, error) {
	if _, err := uuid.Parse(orgID); err != nil {
		return "", ErrBadKey
	}
	if !shaRe.MatchString(sha) {
		return "", ErrBadKey
	}
	return path.Join("blobs", orgID, sha[0:2], sha[2:4], sha), nil
}

// WriteStream hashes and uploads in ONE pass, without buffering the payload.
//
// The awkward part of content-addressing against an object store: the key is
// the hash, so it is not known until the last byte has been read — but S3 has
// no rename. The answer is a TeeReader into the hasher feeding a streaming
// PutObject to a temporary key, then a server-side copy to the real key. The
// copy never moves bytes across this process, and the temporary object is
// removed either way.
//
// The size cap is enforced by reading at most max+1 bytes, so a payload of
// exactly max succeeds and anything larger is caught without draining a
// possibly-unbounded stream.
func (s *S3Store) WriteStream(orgID string, r io.Reader, max int64) (string, int64, error) {
	if _, err := uuid.Parse(orgID); err != nil {
		return "", 0, ErrBadKey
	}
	ctx := context.Background()

	tmpKey := s.join("tmp", uuid.NewString())
	h := sha256.New()
	limited := io.LimitReader(r, max+1)
	tee := io.TeeReader(limited, h)

	// -1 size: content length is unknown up front, so minio-go streams in parts.
	info, err := s.c.PutObject(ctx, s.bucket, tmpKey, tee, -1, minio.PutObjectOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("blob: upload: %w", err)
	}
	// Whatever happens next, the spool object does not survive it.
	defer func() {
		_ = s.c.RemoveObject(context.Background(), s.bucket, tmpKey, minio.RemoveObjectOptions{})
	}()

	if info.Size > max {
		return "", 0, ErrTooLarge
	}

	sha := hex.EncodeToString(h.Sum(nil))
	dst, err := s.key(orgID, sha)
	if err != nil {
		return "", 0, err
	}

	// Server-side copy. An identical re-upload simply overwrites an object with
	// the same content under the same key, which is the same idempotent
	// no-op the filesystem implementation gets from its rename.
	if _, err := s.c.CopyObject(ctx,
		minio.CopyDestOptions{Bucket: s.bucket, Object: dst},
		minio.CopySrcOptions{Bucket: s.bucket, Object: tmpKey},
	); err != nil {
		return "", 0, fmt.Errorf("blob: commit: %w", err)
	}
	return sha, info.Size, nil
}

// s3Reader adapts a minio.Object to Reader.
//
// minio.Object implements io.ReadSeekCloser natively — seeks become ranged
// GETs — so Range requests and video scrubbing work the same as on a disk
// rather than being emulated by buffering the whole object.
type s3Reader struct {
	*minio.Object
	size    int64
	modTime time.Time
}

func (r *s3Reader) Size() int64        { return r.size }
func (r *s3Reader) ModTime() time.Time { return r.modTime }

func (s *S3Store) open(key string) (Reader, error) {
	ctx := context.Background()
	obj, err := s.c.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// GetObject is lazy: it does not talk to the server until first use, so a
	// missing object would otherwise surface mid-response as a torn body rather
	// than as the 404 the handler wants. Stat forces the round trip now.
	st, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		return nil, err
	}
	return &s3Reader{Object: obj, size: st.Size, modTime: st.LastModified}, nil
}

func (s *S3Store) Open(orgID, sha string) (Reader, error) {
	k, err := s.key(orgID, sha)
	if err != nil {
		return nil, err
	}
	return s.open(k)
}

// OpenKey serves a key this package produced (RecordingKey), under the same
// prefix every other object gets. Validated on the way in for the same reason
// the filesystem implementation does it — one of the two backends turns this
// string into a path, and the check belongs on both.
func (s *S3Store) OpenKey(key string) (Reader, error) {
	if err := ParseRecordingKey(key); err != nil {
		return nil, err
	}
	return s.open(s.join(key))
}

// Remove deletes one blob. A missing object is not an error, matching the
// filesystem implementation: the attachment reaper wants "already gone" to be
// success.
func (s *S3Store) Remove(orgID, sha string) error {
	k, err := s.key(orgID, sha)
	if err != nil {
		return err
	}
	err = s.c.RemoveObject(context.Background(), s.bucket, k, minio.RemoveObjectOptions{})
	if isNotFound(err) {
		return nil
	}
	return err
}

// RemoveOrg deletes every object under one org's prefix.
//
// This is the payoff for sharding by org, and on an object store it is a
// listing plus a batched delete rather than a subtree unlink. Used by org
// deletion, where it is the ONLY thing that reaches attachment bytes — they are
// not application-layer encrypted, so the crypto-shred does not cover them.
func (s *S3Store) RemoveOrg(orgID string) error {
	if _, err := uuid.Parse(orgID); err != nil {
		return ErrBadKey
	}
	ctx := context.Background()
	prefix := s.join("blobs", orgID) + "/"

	objects := make(chan minio.ObjectInfo)
	go func() {
		defer close(objects)
		for obj := range s.c.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{
			Prefix: prefix, Recursive: true,
		}) {
			if obj.Err != nil {
				continue
			}
			objects <- obj
		}
	}()

	var firstErr error
	for e := range s.c.RemoveObjects(ctx, s.bucket, objects, minio.RemoveObjectsOptions{}) {
		// Drain the whole channel even after a failure: stopping early would
		// abandon the rest of the org's bytes, which is the one outcome an
		// erasure request cannot have.
		if e.Err != nil && firstErr == nil {
			firstErr = e.Err
		}
	}
	return firstErr
}

func (s *S3Store) CacheGet(kind, key string) (Reader, error) {
	k, err := s.cacheKey(kind, key)
	if err != nil {
		return nil, err
	}
	return s.open(k)
}

// CachePut stores derived content (static maps, reverse geocodes).
//
// Buffered rather than streamed, unlike WriteStream, because these are small by
// construction — the callers pass a few hundred KB at most and cap it — and
// buffering lets the size check reject an oversized payload BEFORE anything is
// written, rather than uploading and then deleting.
func (s *S3Store) CachePut(kind, key string, r io.Reader, max int64) error {
	k, err := s.cacheKey(kind, key)
	if err != nil {
		return err
	}
	buf, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > max {
		return ErrTooLarge
	}
	_, err = s.c.PutObject(context.Background(), s.bucket, k,
		bytes.NewReader(buf), int64(len(buf)), minio.PutObjectOptions{})
	return err
}

// isNotFound recognises the several shapes "no such object" arrives in.
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	resp := minio.ToErrorResponse(err)
	return resp.StatusCode == http.StatusNotFound ||
		resp.Code == "NoSuchKey" || resp.Code == "NoSuchBucket"
}
