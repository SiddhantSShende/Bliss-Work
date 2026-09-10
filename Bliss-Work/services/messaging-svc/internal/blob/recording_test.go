package blob

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	org  = "11111111-1111-4111-8111-111111111111"
	call = "22222222-2222-4222-8222-222222222222"
)

func TestRecordingKeySitsUnderTheOrgPrefixRemoveOrgSweeps(t *testing.T) {
	key, err := RecordingKey(org, call, "EG_abc", "mp4")
	if err != nil {
		t.Fatalf("RecordingKey: %v", err)
	}
	want := "blobs/" + org + "/recordings/" + call + "/EG_abc.mp4"
	if key != want {
		t.Fatalf("key = %q, want %q", key, want)
	}
	// The whole reason for the layout: org erasure removes `blobs/{org}/` and
	// must take recordings with it. A sibling tree would be silently missed.
	if !strings.HasPrefix(key, "blobs/"+org+"/") {
		t.Fatalf("key %q escapes the org prefix RemoveOrg deletes", key)
	}
	if err := ParseRecordingKey(key); err != nil {
		t.Fatalf("a key this package built must parse: %v", err)
	}
}

func TestRecordingKeyRefusesAnythingItDidNotBuild(t *testing.T) {
	for name, args := range map[string][4]string{
		"org is not a uuid":     {"../../etc", call, "EG_1", "mp4"},
		"call is not a uuid":    {org, "..", "EG_1", "mp4"},
		"egress id has a slash": {org, call, "a/../../b", "mp4"},
		"egress id has a dot":   {org, call, "..", "mp4"},
		"extension is a path":   {org, call, "EG_1", "mp4/x"},
		"extension is empty":    {org, call, "EG_1", ""},
	} {
		if _, err := RecordingKey(args[0], args[1], args[2], args[3]); err != ErrBadKey {
			t.Fatalf("%s: err = %v, want ErrBadKey", name, err)
		}
	}
}

func TestParseRecordingKeyRefusesTraversalAndForeignShapes(t *testing.T) {
	for _, key := range []string{
		"",
		"blobs/" + org + "/recordings/" + call + "/../../../../etc/passwd",
		"../blobs/" + org + "/recordings/" + call + "/EG_1.mp4",
		"/etc/passwd",
		// A real attachment path — right tree, wrong resource.
		"blobs/" + org + "/ab/cd/" + strings.Repeat("a", 64),
		// The S3-prefixed form. Deliberately refused: the prefix is the
		// store's to add, and accepting it here would double it.
		"prod/blobs/" + org + "/recordings/" + call + "/EG_1.mp4",
	} {
		if err := ParseRecordingKey(key); err != ErrBadKey {
			t.Fatalf("ParseRecordingKey(%q) = %v, want ErrBadKey", key, err)
		}
	}
}

func TestFSOpenKeyServesTheRecordingAndRefusesEverythingElse(t *testing.T) {
	root := t.TempDir()
	s, err := NewFS(root)
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	key, err := RecordingKey(org, call, "EG_abc", "mp4")
	if err != nil {
		t.Fatalf("RecordingKey: %v", err)
	}
	full := filepath.Join(root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte("video-bytes"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	f, err := s.OpenKey(key)
	if err != nil {
		t.Fatalf("OpenKey: %v", err)
	}
	defer f.Close()
	if f.Size() != int64(len("video-bytes")) {
		t.Fatalf("size = %d", f.Size())
	}

	// The boundary: a key read back out of a database is still untrusted input,
	// because it is about to become a path under the blob root.
	if _, err := s.OpenKey("../../etc/passwd"); err != ErrBadKey {
		t.Fatalf("traversal accepted: %v", err)
	}
}
