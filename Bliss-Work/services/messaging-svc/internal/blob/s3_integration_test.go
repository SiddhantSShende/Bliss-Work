package blob

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// The S3 backend against a REAL S3-compatible server.
//
// Not fakeable in any way worth having. The behaviour this implementation
// depends on is the server's, not ours: that a seek becomes a ranged GET (which
// is what makes video scrubbing work), that a server-side copy commits a
// content-addressed key without moving bytes through this process, that a
// prefix delete removes an org, and that "no such key" arrives in a shape
// isNotFound recognises. A stub would assert our beliefs about MinIO rather
// than MinIO.
//
// Set S3_TEST_ENDPOINT to run:
//
//	docker run -d --rm -p 9010:9000 --name tb-test-minio \
//	  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
//	  minio/minio server /data
//	S3_TEST_ENDPOINT=127.0.0.1:9010 go test ./internal/blob/ -run S3Integration -v
func testS3(t *testing.T) *S3Store {
	t.Helper()
	endpoint := os.Getenv("S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT not set; skipping object-store integration test")
	}
	cfg := S3Config{
		Endpoint:  endpoint,
		Bucket:    getenvOr("S3_TEST_BUCKET", "blisswork-test"),
		AccessKey: getenvOr("S3_TEST_ACCESS_KEY", "minioadmin"),
		SecretKey: getenvOr("S3_TEST_SECRET_KEY", "minioadmin"),
		Region:    "us-east-1",
		UseSSL:    false,
		// Namespaced per run so tests never collide with each other or with
		// anything else sharing the bucket.
		Prefix: "test/" + uuid.NewString(),
	}

	// Create the bucket if this is a fresh server.
	raw, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	ctx := context.Background()
	if ok, _ := raw.BucketExists(ctx, cfg.Bucket); !ok {
		if err := raw.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			t.Fatalf("make bucket: %v", err)
		}
	}

	s, err := NewS3(ctx, cfg)
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	return s
}

func getenvOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestS3IntegrationRoundTrip(t *testing.T) {
	s := testS3(t)
	org := uuid.NewString()
	payload := []byte("the quick brown fox jumps over the lazy dog")
	want := sha256.Sum256(payload)

	sha, n, err := s.WriteStream(org, bytes.NewReader(payload), 1<<20)
	if err != nil {
		t.Fatalf("WriteStream: %v", err)
	}
	if sha != hex.EncodeToString(want[:]) {
		t.Fatalf("sha = %s, want %s", sha, hex.EncodeToString(want[:]))
	}
	if n != int64(len(payload)) {
		t.Fatalf("n = %d, want %d", n, len(payload))
	}

	r, err := s.Open(org, sha)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()
	if r.Size() != int64(len(payload)) {
		t.Fatalf("Size = %d, want %d", r.Size(), len(payload))
	}
	got, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("read back %q (err %v)", got, err)
	}
	if r.ModTime().IsZero() {
		t.Fatal("ModTime is zero; ServeContent needs it for If-Modified-Since")
	}
}

// Seeking is the whole reason Reader is a ReadSeekCloser rather than a Reader:
// http.ServeContent uses it to answer Range requests, which is what lets a user
// scrub a video instead of downloading it whole.
func TestS3IntegrationSeekServesRanges(t *testing.T) {
	s := testS3(t)
	org := uuid.NewString()
	payload := []byte("0123456789abcdefghijklmnopqrstuvwxyz")

	sha, _, err := s.WriteStream(org, bytes.NewReader(payload), 1<<20)
	if err != nil {
		t.Fatalf("WriteStream: %v", err)
	}
	r, err := s.Open(org, sha)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()

	if _, err := r.Seek(10, io.SeekStart); err != nil {
		t.Fatalf("Seek: %v", err)
	}
	buf := make([]byte, 6)
	if _, err := io.ReadFull(r, buf); err != nil {
		t.Fatalf("ReadFull after seek: %v", err)
	}
	if string(buf) != "abcdef" {
		t.Fatalf("after seek got %q, want %q", buf, "abcdef")
	}

	// Seek relative to the end — ServeContent does this to size the response.
	if _, err := r.Seek(-4, io.SeekEnd); err != nil {
		t.Fatalf("SeekEnd: %v", err)
	}
	tail, err := io.ReadAll(r)
	if err != nil || string(tail) != "wxyz" {
		t.Fatalf("tail = %q (err %v), want \"wxyz\"", tail, err)
	}
}

// The layout contract. If these ever diverge from the filesystem layout, an
// existing deployment's attachments.storage_path rows stop resolving after a
// migration — every attachment ever uploaded 404s.
func TestS3IntegrationRelPathMatchesFilesystemLayout(t *testing.T) {
	s := testS3(t)
	fs, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	org := uuid.NewString()
	sha := strings.Repeat("ab", 32)

	s3Path, err := s.RelPath(org, sha)
	if err != nil {
		t.Fatalf("s3 RelPath: %v", err)
	}
	fsPath, err := fs.RelPath(org, sha)
	if err != nil {
		t.Fatalf("fs RelPath: %v", err)
	}
	if s3Path != fsPath {
		t.Fatalf("storage_path diverges: s3 %q vs fs %q", s3Path, fsPath)
	}
	// And the prefix must NOT leak into it — storage_path is relative so the
	// root can move without rewriting rows.
	if strings.Contains(s3Path, s.prefix) {
		t.Fatalf("RelPath %q contains the bucket prefix", s3Path)
	}
}

func TestS3IntegrationRejectsOversizePayload(t *testing.T) {
	s := testS3(t)
	org := uuid.NewString()
	if _, _, err := s.WriteStream(org, bytes.NewReader(make([]byte, 64)), 32); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("WriteStream oversize err = %v, want ErrTooLarge", err)
	}
}

// Validation is the security boundary here just as it is on a disk. A key
// cannot escape a bucket with "..", but an unvalidated orgID would let a caller
// read or overwrite another org's prefix, which is the same breach.
func TestS3IntegrationRejectsBadKeys(t *testing.T) {
	s := testS3(t)
	good := strings.Repeat("ab", 32)
	org := uuid.NewString()

	for name, fn := range map[string]func() error{
		"open bad org":   func() error { _, err := s.Open("../../etc", good); return err },
		"open bad sha":   func() error { _, err := s.Open(org, "../../../etc/passwd"); return err },
		"open short sha": func() error { _, err := s.Open(org, "abc"); return err },
		"remove bad org": func() error { return s.Remove("not-a-uuid", good) },
		"removeorg bad":  func() error { return s.RemoveOrg("../../..") },
		"write bad org":  func() error { _, _, err := s.WriteStream("nope", bytes.NewReader(nil), 16); return err },
		"cache bad kind": func() error { _, err := s.CacheGet("../etc", good); return err },
		"cache bad key":  func() error { _, err := s.CacheGet("maps", "../../x"); return err },
	} {
		if err := fn(); !errors.Is(err, ErrBadKey) {
			t.Errorf("%s: err = %v, want ErrBadKey", name, err)
		}
	}
}

// "Already gone" is the desired end state for the attachment reaper, so a
// missing object must not be an error.
func TestS3IntegrationRemoveIsIdempotent(t *testing.T) {
	s := testS3(t)
	org := uuid.NewString()
	sha, _, err := s.WriteStream(org, strings.NewReader("bytes"), 1<<20)
	if err != nil {
		t.Fatalf("WriteStream: %v", err)
	}
	if err := s.Remove(org, sha); err != nil {
		t.Fatalf("first Remove: %v", err)
	}
	if err := s.Remove(org, sha); err != nil {
		t.Fatalf("second Remove on a missing object: %v", err)
	}
	if _, err := s.Open(org, sha); err == nil {
		t.Fatal("Open succeeded after Remove")
	}
}

// Org deletion. This is the only thing that reaches attachment bytes when a
// workspace is erased — they are not application-layer encrypted, so the
// crypto-shred does not cover them.
func TestS3IntegrationRemoveOrgErasesEverythingAndNothingElse(t *testing.T) {
	s := testS3(t)
	doomed, keeper := uuid.NewString(), uuid.NewString()

	var doomedShas []string
	for _, body := range []string{"one", "two", "three"} {
		sha, _, err := s.WriteStream(doomed, strings.NewReader(body), 1<<20)
		if err != nil {
			t.Fatalf("seed doomed: %v", err)
		}
		doomedShas = append(doomedShas, sha)
	}
	keptSha, _, err := s.WriteStream(keeper, strings.NewReader("survivor"), 1<<20)
	if err != nil {
		t.Fatalf("seed keeper: %v", err)
	}

	if err := s.RemoveOrg(doomed); err != nil {
		t.Fatalf("RemoveOrg: %v", err)
	}
	for _, sha := range doomedShas {
		if _, err := s.Open(doomed, sha); err == nil {
			t.Errorf("blob %s survived RemoveOrg", sha[:8])
		}
	}
	// The neighbouring org is the assertion that matters: an erasure that takes
	// someone else's data with it is a worse bug than one that leaves data.
	r, err := s.Open(keeper, keptSha)
	if err != nil {
		t.Fatalf("other org's blob was destroyed: %v", err)
	}
	_ = r.Close()

	// Idempotent, because the event driving it can be redelivered.
	if err := s.RemoveOrg(doomed); err != nil {
		t.Fatalf("second RemoveOrg: %v", err)
	}
}

// The derived-content cache, including the "geocode" kind that the filesystem
// implementation used to reject outright.
func TestS3IntegrationCacheRoundTrip(t *testing.T) {
	s := testS3(t)
	key := strings.Repeat("cd", 32)

	for _, kind := range []string{"maps", "geocode"} {
		if err := s.CachePut(kind, key, strings.NewReader("cached-"+kind), 1<<20); err != nil {
			t.Fatalf("CachePut %s: %v", kind, err)
		}
		r, err := s.CacheGet(kind, key)
		if err != nil {
			t.Fatalf("CacheGet %s: %v", kind, err)
		}
		got, _ := io.ReadAll(r)
		_ = r.Close()
		if string(got) != "cached-"+kind {
			t.Fatalf("%s cache = %q", kind, got)
		}
	}

	if err := s.CachePut("maps", key, strings.NewReader("way too long"), 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize CachePut err = %v, want ErrTooLarge", err)
	}
}
