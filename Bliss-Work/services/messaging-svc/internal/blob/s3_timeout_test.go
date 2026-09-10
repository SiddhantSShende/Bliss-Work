package blob

// S3Store's calls must return an error, not hang forever, when the backend
// stops answering. Every method used to run on context.Background(), so a
// dead backend wedged the calling goroutine permanently — for Open/
// WriteStream that is a request handler that never returns; for RemoveOrg it
// is org deletion's only path to attachment bytes silently stuck.
//
// No real MinIO needed: a raw listener that accepts a connection and then
// never reads or writes anything reproduces "stopped answering" exactly, and
// the s3*Timeout vars are overridden to a few milliseconds so this test
// doesn't actually wait out the production bounds.

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const testSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"

// hangingServer accepts TCP connections and holds them open without ever
// reading or writing — the shape of a backend that is up at the network
// level but has stopped answering entirely.
func hangingServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed at test cleanup
			}
			_ = conn // held open, never serviced
		}
	}()
	return ln.Addr().String()
}

func hungStore(t *testing.T) *S3Store {
	t.Helper()
	c, err := minio.New(hangingServer(t), &minio.Options{
		Creds:  credentials.NewStaticV4("test", "test", ""),
		Secure: false,
	})
	if err != nil {
		t.Fatalf("minio.New: %v", err)
	}
	return &S3Store{c: c, bucket: "test-bucket"}
}

// withShortTimeouts overrides the three package-level bounds for the
// duration of one test, restoring them on cleanup — these are the ONLY thing
// that stands between a hung backend and a permanently blocked goroutine, so
// the test must prove they are actually being used, not just declared.
func withShortTimeouts(t *testing.T) {
	t.Helper()
	origControl, origWrite, origBulk := s3ControlTimeout, s3WriteTimeout, s3BulkTimeout
	s3ControlTimeout = 50 * time.Millisecond
	s3WriteTimeout = 50 * time.Millisecond
	s3BulkTimeout = 50 * time.Millisecond
	t.Cleanup(func() {
		s3ControlTimeout, s3WriteTimeout, s3BulkTimeout = origControl, origWrite, origBulk
	})
}

// assertBounded runs fn and fails the test if it doesn't return within
// `bound` — proof the call did NOT hang forever against the dead backend.
func assertBounded(t *testing.T, bound time.Duration, fn func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		if err == nil {
			t.Error("expected an error against a backend that never answers, got nil")
		}
	case <-time.After(bound):
		t.Fatalf("call did not return within %s — it is hanging exactly as the pre-fix code did", bound)
	}
}

func TestWriteStream_DoesNotHangAgainstADeadBackend(t *testing.T) {
	withShortTimeouts(t)
	s := hungStore(t)
	assertBounded(t, 2*time.Second, func() error {
		_, _, err := s.WriteStream(testOrg, strings.NewReader("hello"), 1<<20)
		return err
	})
}

func TestRemove_DoesNotHangAgainstADeadBackend(t *testing.T) {
	withShortTimeouts(t)
	s := hungStore(t)
	assertBounded(t, 2*time.Second, func() error {
		return s.Remove(testOrg, testSha)
	})
}

func TestRemoveOrg_DoesNotHangAgainstADeadBackend(t *testing.T) {
	withShortTimeouts(t)
	s := hungStore(t)
	assertBounded(t, 2*time.Second, func() error {
		return s.RemoveOrg(testOrg)
	})
}

func TestCachePut_DoesNotHangAgainstADeadBackend(t *testing.T) {
	withShortTimeouts(t)
	s := hungStore(t)
	assertBounded(t, 2*time.Second, func() error {
		return s.CachePut("maps", testSha, strings.NewReader("x"), 1<<20)
	})
}

func TestOpen_DoesNotHangAgainstADeadBackend(t *testing.T) {
	// The tricky one: open() must bound the initial Stat() probe without
	// bounding the handle it hands back for actual streaming (see its own
	// doc comment). This only exercises the probe, which is where the
	// pre-fix code hung.
	withShortTimeouts(t)
	s := hungStore(t)
	assertBounded(t, 2*time.Second, func() error {
		_, err := s.Open(testOrg, testSha)
		return err
	})
}
