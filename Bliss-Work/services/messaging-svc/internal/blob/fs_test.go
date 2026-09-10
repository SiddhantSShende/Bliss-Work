package blob

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testOrg = "018f0000-0000-7000-8000-0000000000aa"

func newTestStore(t *testing.T) *FSStore {
	t.Helper()
	s, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func TestWriteStream_ContentAddress(t *testing.T) {
	s := newTestStore(t)
	payload := []byte("hello attachments")
	want := sha256.Sum256(payload)

	sha, n, err := s.WriteStream(testOrg, bytes.NewReader(payload), 1024)
	if err != nil {
		t.Fatalf("WriteStream: %v", err)
	}
	if sha != hex.EncodeToString(want[:]) {
		t.Errorf("sha = %s, want %s", sha, hex.EncodeToString(want[:]))
	}
	if n != int64(len(payload)) {
		t.Errorf("n = %d, want %d", n, len(payload))
	}

	f, err := s.Open(testOrg, sha)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer f.Close()
	if f.Size() != int64(len(payload)) {
		t.Errorf("stored size = %d", f.Size())
	}
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, payload) {
		t.Error("stored bytes differ from input")
	}
}

// A payload of exactly max must succeed; max+1 must fail. Off-by-one here means
// either rejecting legitimate 100 MB uploads or accepting unbounded ones.
func TestWriteStream_LimitBoundary(t *testing.T) {
	s := newTestStore(t)
	if _, n, err := s.WriteStream(testOrg, bytes.NewReader(make([]byte, 100)), 100); err != nil || n != 100 {
		t.Fatalf("exactly-max upload failed: n=%d err=%v", n, err)
	}
	if _, _, err := s.WriteStream(testOrg, bytes.NewReader(make([]byte, 101)), 100); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("over-max upload err = %v, want ErrTooLarge", err)
	}
}

// An oversized upload must not leave its partial spool behind — otherwise
// repeatedly starting-and-abandoning uploads fills the volume for free.
func TestWriteStream_OversizeLeavesNoTempFile(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.WriteStream(testOrg, bytes.NewReader(make([]byte, 5000)), 100); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	entries, err := os.ReadDir(filepath.Join(s.Root(), "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("spool dir not cleaned: %d file(s) left", len(entries))
	}
}

// A read error mid-stream (client disconnect) must also clean up.
func TestWriteStream_ReadErrorLeavesNoTempFile(t *testing.T) {
	s := newTestStore(t)
	r := io.MultiReader(bytes.NewReader([]byte("partial")), errReader{})
	if _, _, err := s.WriteStream(testOrg, r, 1024); err == nil {
		t.Fatal("expected an error from a failing reader")
	}
	entries, _ := os.ReadDir(filepath.Join(s.Root(), "tmp"))
	if len(entries) != 0 {
		t.Fatalf("spool dir not cleaned after read error: %d file(s)", len(entries))
	}
}

func TestWriteStream_DedupesIdenticalContent(t *testing.T) {
	s := newTestStore(t)
	payload := []byte("same bytes twice")

	sha1, _, err := s.WriteStream(testOrg, bytes.NewReader(payload), 1024)
	if err != nil {
		t.Fatal(err)
	}
	sha2, _, err := s.WriteStream(testOrg, bytes.NewReader(payload), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if sha1 != sha2 {
		t.Fatalf("same content produced different addresses: %s vs %s", sha1, sha2)
	}
	// One blob on disk, and no spool residue from the deduped second write.
	if entries, _ := os.ReadDir(filepath.Join(s.Root(), "tmp")); len(entries) != 0 {
		t.Errorf("dedupe left %d spool file(s)", len(entries))
	}
	f, err := s.Open(testOrg, sha2)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}

// Orgs are separate namespaces: the same bytes stored by two orgs must be two
// independent files, so deleting one org's data cannot affect the other.
func TestWriteStream_OrgsAreIsolated(t *testing.T) {
	s := newTestStore(t)
	const otherOrg = "018f0000-0000-7000-8000-0000000000bb"
	payload := []byte("shared content")

	sha, _, err := s.WriteStream(testOrg, bytes.NewReader(payload), 1024)
	if err != nil {
		t.Fatal(err)
	}
	// Not visible to the other org before it uploads.
	if _, err := s.Open(otherOrg, sha); err == nil {
		t.Fatal("org B could read org A's blob by content address")
	}
	if _, _, err := s.WriteStream(otherOrg, bytes.NewReader(payload), 1024); err != nil {
		t.Fatal(err)
	}
	// Removing A's copy leaves B's intact.
	if err := s.Remove(testOrg, sha); err != nil {
		t.Fatal(err)
	}
	if f, err := s.Open(otherOrg, sha); err != nil {
		t.Fatal("removing org A's blob destroyed org B's copy")
	} else {
		f.Close()
	}
}

// THE path-traversal boundary. orgID and sha are the only caller-controlled
// path components; both must be rejected before any filesystem join.
func TestPathTraversalRejected(t *testing.T) {
	s := newTestStore(t)

	badShas := []string{
		"../../../etc/passwd",
		"..",
		"/etc/passwd",
		strings.Repeat("g", 64),                  // right length, not hex
		strings.Repeat("a", 63),                  // too short
		strings.Repeat("a", 65),                  // too long
		strings.ToUpper(strings.Repeat("a", 64)), // uppercase hex
		"",
		"a/b",
	}
	for _, sha := range badShas {
		if _, err := s.Open(testOrg, sha); !errors.Is(err, ErrBadKey) {
			t.Errorf("Open(sha=%q) err = %v, want ErrBadKey", sha, err)
		}
		if _, err := s.RelPath(testOrg, sha); !errors.Is(err, ErrBadKey) {
			t.Errorf("RelPath(sha=%q) err = %v, want ErrBadKey", sha, err)
		}
		if err := s.Remove(testOrg, sha); !errors.Is(err, ErrBadKey) {
			t.Errorf("Remove(sha=%q) err = %v, want ErrBadKey", sha, err)
		}
	}

	validSha := strings.Repeat("a", 64)
	badOrgs := []string{"../../etc", "..", "", "not-a-uuid", "/absolute", "org/../../x"}
	for _, org := range badOrgs {
		if _, err := s.Open(org, validSha); !errors.Is(err, ErrBadKey) {
			t.Errorf("Open(org=%q) err = %v, want ErrBadKey", org, err)
		}
		if _, _, err := s.WriteStream(org, bytes.NewReader([]byte("x")), 16); !errors.Is(err, ErrBadKey) {
			t.Errorf("WriteStream(org=%q) err = %v, want ErrBadKey", org, err)
		}
	}
}

// Nothing may be written outside the root, even given hostile keys.
func TestWriteStream_StaysInsideRoot(t *testing.T) {
	s := newTestStore(t)
	sha, _, err := s.WriteStream(testOrg, bytes.NewReader([]byte("contained")), 1024)
	if err != nil {
		t.Fatal(err)
	}
	rel, err := s.RelPath(testOrg, sha)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		t.Fatalf("storage_path escapes the root: %q", rel)
	}
	if _, err := os.Stat(filepath.Join(s.Root(), rel)); err != nil {
		t.Fatalf("storage_path does not resolve under root: %v", err)
	}
}

func TestRemove_MissingIsNotAnError(t *testing.T) {
	s := newTestStore(t)
	if err := s.Remove(testOrg, strings.Repeat("b", 64)); err != nil {
		t.Fatalf("removing an absent blob returned %v; the reaper must be idempotent", err)
	}
}

func TestCache_RoundTripAndKeyValidation(t *testing.T) {
	s := newTestStore(t)
	key := strings.Repeat("c", 32)

	if err := s.CachePut("maps", key, bytes.NewReader([]byte("PNGDATA")), 1024); err != nil {
		t.Fatalf("CachePut: %v", err)
	}
	f, err := s.CacheGet("maps", key)
	if err != nil {
		t.Fatalf("CacheGet: %v", err)
	}
	defer f.Close()
	if f.Size() != 7 {
		t.Errorf("cached size = %d, want 7", f.Size())
	}

	for _, bad := range []string{"../../etc/passwd", "", "zz", strings.Repeat("z", 32)} {
		if _, err := s.CacheGet("maps", bad); !errors.Is(err, ErrBadKey) && err == nil {
			t.Errorf("CacheGet(%q) unexpectedly succeeded", bad)
		}
	}
	// Only the maps namespace exists; anything else is a programming error.
	if _, err := s.CacheGet("blobs", key); !errors.Is(err, ErrBadKey) {
		t.Errorf("CacheGet with a non-cache kind err = %v, want ErrBadKey", err)
	}
}

func TestNew_RejectsEmptyRoot(t *testing.T) {
	if _, err := NewFS("   "); err == nil {
		t.Fatal("New accepted an empty root")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("boom") }
