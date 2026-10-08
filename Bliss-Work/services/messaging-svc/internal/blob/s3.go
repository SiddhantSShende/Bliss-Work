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

// Every S3 call below used to run on context.Background() — no deadline at
// all, so a backend that stops answering (network partition, an overloaded
// MinIO, a stalled TLS handshake) hangs the calling goroutine FOREVER. For
// Open/WriteStream that is a request handler that never returns; for
// RemoveOrg it is the only thing that reaches attachment bytes on org
// deletion (see its own doc comment) silently wedged.
//
// Three bounds rather than one: the calls have genuinely different natural
// durations, and a single timeout would either fire on legitimate large
// uploads or be too generous to bound a hung small delete promptly.
//
// var, not const: FOR TESTS ONLY, so a test proving a hung backend no longer
// blocks forever can use a millisecond-scale bound instead of actually
// waiting out the production value.
var (
	// s3ControlTimeout bounds a single metadata/control-plane round trip:
	// the existence probe in open(), Remove, CachePut's few-hundred-KB write.
	// Generous relative to a healthy backend's real latency, so it only ever
	// fires against one that has stopped answering entirely.
	s3ControlTimeout = 30 * time.Second

	// s3WriteTimeout bounds WriteStream's upload. Sized against
	// MEDIA_MAX_BYTES at a pessimistic sustained rate, so a legitimate
	// large-but-slow upload still completes rather than being cut off by an
	// overly tight bound.
	s3WriteTimeout = 5 * time.Minute

	// s3BulkTimeout bounds RemoveOrg, which lists and deletes every object
	// under one org's prefix. Unlike the other calls this can legitimately
	// take a while for an org with many attachments, and unlike a live HTTP
	// request nothing is blocked on it synchronously — it is fine to be more
	// patient here than anywhere else in this file.
	s3BulkTimeout = 10 * time.Minute
)

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
	ctx, cancel := context.WithTimeout(context.Background(), s3WriteTimeout)
	defer cancel()

	tmpKey := s.join("tmp", uuid.NewString())
	h := sha256.New()
	limited := io.LimitReader(r, max+1)
	tee := io.TeeReader(limited, h)

	// -1 size: content length is unknown up front, so minio-go streams in parts.
	info, err := s.c.PutObject(ctx, s.bucket, tmpKey, tee, -1, minio.PutObjectOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("blob: upload: %w", err)
	}
	// Whatever happens next, the spool object does not survive it. A fresh
	// timeout, not `ctx`: if WriteStream is returning because ITS deadline
	// already fired, ctx is already cancelled and cleanup would no-op instead
	// of actually trying.
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), s3ControlTimeout)
		defer cleanupCancel()
		_ = s.c.RemoveObject(cleanupCtx, s.bucket, tmpKey, minio.RemoveObjectOptions{})
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
	// GetObject is lazy — it does not talk to the server until first use — but
	// Stat below forces that first round trip right here, synchronously, so a
	// missing object surfaces as the 404 the handler wants instead of a torn
	// body mid-response. minio-go ties Stat (and every later Read/Seek) to the
	// SAME context GetObject was given, so bounding that context to fail fast
	// against a hung backend would just as surely cut off a slow-but-healthy
	// download partway through streaming — video scrubbing on a large
	// recording can legitimately run far longer than any reasonable timeout.
	//
	// So: probe with a bounded, throwaway handle just to force and time out
	// the existence/metadata round trip, then hand the caller a SECOND,
	// unbounded handle for the actual read. GetObject itself does no network
	// call, so the second construction costs nothing extra — only Stat (used
	// once, on the probe) is a real round trip.
	probeCtx, cancel := context.WithTimeout(context.Background(), s3ControlTimeout)
	defer cancel()
	probe, err := s.c.GetObject(probeCtx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	st, err := probe.Stat()
	_ = probe.Close()
	if err != nil {
		return nil, err
	}

	obj, err := s.c.GetObject(context.Background(), s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
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
	ctx, cancel := context.WithTimeout(context.Background(), s3ControlTimeout)
	defer cancel()
	err = s.c.RemoveObject(ctx, s.bucket, k, minio.RemoveObjectOptions{})
	if err != nil && !isNotFound(err) {
		return err
	}
	return s.removeDerived(ctx, k)
}

func (s *S3Store) derivedKey(orgID, sha, variant string) (string, error) {
	if !ValidVariant(variant) {
		return "", ErrBadKey
	}
	k, err := s.key(orgID, sha)
	if err != nil {
		return "", err
	}
	return k + "." + variant, nil
}

// removeDerived deletes every "{key}.v*" sibling of the blob at key k.
func (s *S3Store) removeDerived(ctx context.Context, k string) error {
	for obj := range s.c.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: k + ".v"}) {
		if obj.Err != nil {
			return obj.Err
		}
		if !ValidVariant(strings.TrimPrefix(obj.Key, k+".")) {
			continue
		}
		if err := s.c.RemoveObject(ctx, s.bucket, obj.Key, minio.RemoveObjectOptions{}); err != nil && !isNotFound(err) {
			return err
		}
	}
	return nil
}

// PutDerived streams a derivative to its key. An S3 object only becomes visible
// when its upload completes, so a derivative is complete or absent. The size cap
// is enforced by reading at most max+1 bytes; an over-size upload is deleted
// again so nothing oversize survives. Streaming (size -1), not buffered: a
// converted PDF can be tens of MB and this service is memory-capped.
func (s *S3Store) PutDerived(orgID, sha, variant string, r io.Reader, max int64) error {
	k, err := s.derivedKey(orgID, sha, variant)
	if err != nil {
		return err
	}
	if max <= 0 {
		return errors.New("blob: max must be positive")
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3WriteTimeout)
	defer cancel()
	info, err := s.c.PutObject(ctx, s.bucket, k, io.LimitReader(r, max+1), -1, minio.PutObjectOptions{})
	if err != nil {
		return fmt.Errorf("blob: upload derived: %w", err)
	}
	if info.Size > max {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), s3ControlTimeout)
		defer cleanupCancel()
		_ = s.c.RemoveObject(cleanupCtx, s.bucket, k, minio.RemoveObjectOptions{})
		return ErrTooLarge
	}
	return nil
}

// OpenDerived returns a stored derivative, or a not-found error.
func (s *S3Store) OpenDerived(orgID, sha, variant string) (Reader, error) {
	k, err := s.derivedKey(orgID, sha, variant)
	if err != nil {
		return nil, err
	}
	return s.open(k)
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
	ctx, cancel := context.WithTimeout(context.Background(), s3BulkTimeout)
	defer cancel()
	prefix := s.join("blobs", orgID) + "/"

	// listErr is written only by the goroutine below, and only read after its
	// `objects` channel has been drained AND closed by RemoveObjects — the
	// close is a synchronization point, so this needs no lock.
	var listErr error
	objects := make(chan minio.ObjectInfo)
	go func() {
		defer close(objects)
		for obj := range s.c.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{
			Prefix: prefix, Recursive: true,
		}) {
			if obj.Err != nil {
				// Was silently discarded here before: with no timeout, the
				// only realistic source of obj.Err was a genuine listing
				// fault. Now that ctx can expire mid-list, minio-go reports
				// THAT as one final obj.Err before closing the channel — so
				// swallowing it would make a timed-out, incomplete erasure
				// return nil, i.e. report success for an org that still has
				// attachment bytes sitting in the bucket.
				listErr = obj.Err
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
	if firstErr == nil {
		firstErr = listErr
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
	ctx, cancel := context.WithTimeout(context.Background(), s3ControlTimeout)
	defer cancel()
	_, err = s.c.PutObject(ctx, s.bucket, k,
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
