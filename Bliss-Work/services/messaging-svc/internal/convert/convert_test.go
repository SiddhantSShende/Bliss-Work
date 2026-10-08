package convert

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/media"
)

// The sandbox is an external service, so these tests stand up a stand-in for IT
// (an httptest server speaking its protocol). The blob store is the REAL
// filesystem store: what is under test is how this side verifies, stores and
// de-duplicates what the sandbox returns.

const (
	testOrg = "018f0000-0000-7000-8000-0000000000aa"
	pdfBody = "%PDF-1.7 converted"
)

type fakeSandbox struct {
	srv   *httptest.Server
	calls atomic.Int32
	// handler decides the reply; default is a valid PDF for docx.
	handler func(w http.ResponseWriter, r *http.Request, body []byte)
}

func newSandbox(t *testing.T, h func(w http.ResponseWriter, r *http.Request, body []byte)) *fakeSandbox {
	t.Helper()
	f := &fakeSandbox{handler: h}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		f.handler(w, r, body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func okPDF(w http.ResponseWriter, _ *http.Request, _ []byte) {
	w.Header().Set("X-Preview-Kind", "pdf")
	w.Header().Set("Content-Type", "application/pdf")
	_, _ = io.WriteString(w, pdfBody)
}

func sandboxError(status int, code string) func(http.ResponseWriter, *http.Request, []byte) {
	return func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
	}
}

func newEnv(t *testing.T, h func(http.ResponseWriter, *http.Request, []byte)) (*Service, *fakeSandbox, blob.Store, string) {
	t.Helper()
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sha, _, err := store.WriteStream(testOrg, strings.NewReader("PK\x03\x04 pretend docx bytes"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sb := newSandbox(t, h)
	svc := NewService(store, NewClient(sb.srv.URL, 10*time.Second), Config{
		Wait: 3 * time.Second, RunTimeout: 10 * time.Second, MaxOutput: 1 << 20, MaxSheets: 1 << 20,
		MaxInFlight: 2, FailureTTL: time.Minute, BusyRetry: 20 * time.Millisecond,
	})
	return svc, sb, store, sha
}

func docx() media.PreviewSpec { s, _ := media.PreviewFor("a.docx"); return s }
func xlsx() media.PreviewSpec { s, _ := media.PreviewFor("a.xlsx"); return s }

func TestEnsure_ConvertsStoresAndThenIsReady(t *testing.T) {
	var gotKind, gotLen string
	var gotBody []byte
	svc, sb, store, sha := newEnv(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		gotKind, gotLen, gotBody = r.URL.Query().Get("kind"), r.Header.Get("Content-Length"), body
		okPDF(w, r, body)
	})
	ready, err := svc.Ensure(context.Background(), testOrg, sha, docx())
	if err != nil || !ready {
		t.Fatalf("Ensure = %v, %v", ready, err)
	}
	if gotKind != "docx" || !bytes.HasPrefix(gotBody, []byte("PK\x03\x04")) || gotLen == "" {
		t.Fatalf("sandbox saw kind=%q len=%q body=%q", gotKind, gotLen, gotBody)
	}
	r, err := store.OpenDerived(testOrg, sha, "v1.pdf")
	if err != nil {
		t.Fatalf("derivative not stored: %v", err)
	}
	b, _ := io.ReadAll(r)
	r.Close()
	if string(b) != pdfBody {
		t.Fatalf("stored %q", b)
	}
	// Second ask: a cache hit, the sandbox is not called again.
	if ready, err := svc.Ensure(context.Background(), testOrg, sha, docx()); err != nil || !ready {
		t.Fatalf("second Ensure = %v, %v", ready, err)
	}
	if sb.calls.Load() != 1 {
		t.Fatalf("sandbox called %d times, want 1", sb.calls.Load())
	}
}

func TestEnsure_SlowConversionAnswersPendingAndKeepsGoing(t *testing.T) {
	release := make(chan struct{})
	svc, sb, _, sha := newEnv(t, func(w http.ResponseWriter, r *http.Request, b []byte) {
		<-release
		okPDF(w, r, b)
	})
	svc.cfg.Wait = 100 * time.Millisecond
	ready, err := svc.Ensure(context.Background(), testOrg, sha, docx())
	if err != nil || ready {
		t.Fatalf("want pending, got ready=%v err=%v", ready, err)
	}
	// The caller went away; the conversion must NOT depend on it.
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for !svc.Ready(testOrg, sha, docx()) {
		if time.Now().After(deadline) {
			t.Fatal("conversion never completed in the background")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sb.calls.Load() != 1 {
		t.Fatalf("sandbox called %d times", sb.calls.Load())
	}
}

func TestEnsure_ConcurrentCallersShareOneConversion(t *testing.T) {
	gate := make(chan struct{})
	svc, sb, _, sha := newEnv(t, func(w http.ResponseWriter, r *http.Request, b []byte) {
		<-gate
		okPDF(w, r, b)
	})
	var wg sync.WaitGroup
	results := make([]bool, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ready, err := svc.Ensure(context.Background(), testOrg, sha, docx())
			results[i] = ready && err == nil
		}()
	}
	time.Sleep(150 * time.Millisecond)
	close(gate)
	wg.Wait()
	for i, ok := range results {
		if !ok {
			t.Errorf("caller %d did not get a ready preview", i)
		}
	}
	if n := sb.calls.Load(); n != 1 {
		t.Fatalf("%d sandbox conversions for one document, want 1", n)
	}
}

func TestEnsure_SandboxFailuresMapToTheClosedErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		code   string
		want   error
		cached bool
	}{
		{"unconvertible", 422, "unconvertible", ErrUnconvertible, true},
		{"limit", 422, "limit", ErrLimit, true},
		{"timeout", 422, "timeout", ErrTimeout, true},
		{"too large", 413, "too_large", ErrTooLarge, true},
		{"unsupported", 415, "unsupported", ErrUnsupported, true},
		{"internal", 500, "internal", ErrUnavailable, false},
		{"unknown code", 422, "something-new", ErrUnavailable, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			svc, sb, _, sha := newEnv(t, sandboxError(c.status, c.code))
			_, err := svc.Ensure(context.Background(), testOrg, sha, docx())
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if svc.Ready(testOrg, sha, docx()) {
				t.Fatal("a failed conversion left a derivative")
			}
			// A deterministic failure is remembered, so the sandbox is not asked
			// again; a busy or unavailable sandbox is never held against the document.
			_, _ = svc.Ensure(context.Background(), testOrg, sha, docx())
			wantCalls := int32(2)
			if c.cached {
				wantCalls = 1
			}
			if sb.calls.Load() != wantCalls {
				t.Fatalf("sandbox calls = %d, want %d (cached=%v)", sb.calls.Load(), wantCalls, c.cached)
			}
		})
	}
}

// A busy sandbox is a queue, not a failure: this side keeps asking until its run
// budget is spent.
func TestEnsure_ABusySandboxIsRetriedUntilItHasRoom(t *testing.T) {
	var asked atomic.Int32
	svc, sb, _, sha := newEnv(t, func(w http.ResponseWriter, r *http.Request, b []byte) {
		if asked.Add(1) <= 3 {
			sandboxError(503, "busy")(w, r, b)
			return
		}
		okPDF(w, r, b)
	})
	ready, err := svc.Ensure(context.Background(), testOrg, sha, docx())
	if err != nil || !ready {
		t.Fatalf("Ensure = %v, %v", ready, err)
	}
	if sb.calls.Load() != 4 {
		t.Fatalf("sandbox asked %d times, want 4 (3 busy + 1 ok)", sb.calls.Load())
	}
	if !svc.Ready(testOrg, sha, docx()) {
		t.Fatal("no derivative stored")
	}
}

func TestEnsure_ASandboxBusyForTheWholeBudgetIsBusyAndNotRemembered(t *testing.T) {
	svc, _, _, sha := newEnv(t, sandboxError(503, "busy"))
	svc.cfg.RunTimeout = 300 * time.Millisecond
	_, err := svc.Ensure(context.Background(), testOrg, sha, docx())
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	if err := svc.Remembered(testOrg, sha, docx()); err != nil {
		t.Fatalf("a busy sandbox was held against the document: %v", err)
	}
}

func TestEnsure_RefusesAnArtifactThatIsNotWhatWasAskedFor(t *testing.T) {
	bad := map[string]func(http.ResponseWriter, *http.Request, []byte){
		"not a pdf": func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			w.Header().Set("X-Preview-Kind", "pdf")
			_, _ = io.WriteString(w, "<html><script>alert(1)</script></html>")
		},
		"wrong kind header": func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			w.Header().Set("X-Preview-Kind", "sheets")
			_, _ = io.WriteString(w, pdfBody)
		},
		"no kind header": func(w http.ResponseWriter, _ *http.Request, _ []byte) { _, _ = io.WriteString(w, pdfBody) },
		"empty body": func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			w.Header().Set("X-Preview-Kind", "pdf")
		},
	}
	for name, h := range bad {
		t.Run(name, func(t *testing.T) {
			svc, _, _, sha := newEnv(t, h)
			_, err := svc.Ensure(context.Background(), testOrg, sha, docx())
			if !errors.Is(err, ErrBadArtifact) {
				t.Fatalf("err = %v, want ErrBadArtifact", err)
			}
			if svc.Ready(testOrg, sha, docx()) {
				t.Fatal("an unverified artifact was stored")
			}
		})
	}
}

func TestEnsure_SheetsArtifactMustBeValidJSON(t *testing.T) {
	good := `{"sheets":[{"name":"A","csv":"1,2\n","totalRows":1,"truncated":false}],"moreSheets":false}`
	svc, _, store, sha := newEnv(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("X-Preview-Kind", "sheets")
		_, _ = io.WriteString(w, good)
	})
	if ready, err := svc.Ensure(context.Background(), testOrg, sha, xlsx()); err != nil || !ready {
		t.Fatalf("valid sheets: %v %v", ready, err)
	}
	r, err := store.OpenDerived(testOrg, sha, "v1.json")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r)
	r.Close()
	if string(b) != good {
		t.Fatalf("stored %q", b)
	}

	svc2, _, _, sha2 := newEnv(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("X-Preview-Kind", "sheets")
		_, _ = io.WriteString(w, `{"sheets": [truncated`)
	})
	if _, err := svc2.Ensure(context.Background(), testOrg, sha2, xlsx()); !errors.Is(err, ErrBadArtifact) {
		t.Fatalf("invalid JSON: err = %v", err)
	}
}

func TestEnsure_OutputOverTheCapStoresNothing(t *testing.T) {
	svc, _, _, sha := newEnv(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("X-Preview-Kind", "pdf")
		_, _ = io.WriteString(w, "%PDF-"+strings.Repeat("x", 4096))
	})
	svc.cfg.MaxOutput = 100
	if _, err := svc.Ensure(context.Background(), testOrg, sha, docx()); !errors.Is(err, ErrLimit) {
		t.Fatalf("err = %v, want ErrLimit", err)
	}
	if svc.Ready(testOrg, sha, docx()) {
		t.Fatal("an oversize artifact was stored")
	}

	svc2, _, _, sha2 := newEnv(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("X-Preview-Kind", "sheets")
		_, _ = io.WriteString(w, `{"sheets":[],"pad":"`+strings.Repeat("x", 4096)+`"}`)
	})
	svc2.cfg.MaxSheets = 100
	if _, err := svc2.Ensure(context.Background(), testOrg, sha2, xlsx()); !errors.Is(err, ErrLimit) {
		t.Fatalf("sheets over cap: err = %v, want ErrLimit", err)
	}
}

func TestEnsure_UnreachableSandboxIsUnavailableAndNotRemembered(t *testing.T) {
	store, _ := blob.NewFS(t.TempDir())
	sha, _, _ := store.WriteStream(testOrg, strings.NewReader("PK\x03\x04x"), 1<<20)
	svc := NewService(store, NewClient("http://127.0.0.1:1", 2*time.Second), Config{
		Wait: 2 * time.Second, RunTimeout: 3 * time.Second, MaxOutput: 1 << 20, MaxSheets: 1 << 20, MaxInFlight: 1, FailureTTL: time.Minute,
	})
	if _, err := svc.Ensure(context.Background(), testOrg, sha, docx()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if err := svc.Remembered(testOrg, sha, docx()); err != nil {
		t.Fatalf("an unreachable sandbox was held against the document: %v", err)
	}
}

func TestClient_DoesNotFollowRedirects(t *testing.T) {
	hit := atomic.Bool{}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hit.Store(true) }))
	defer other.Close()
	sb := newSandbox(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	})
	c := NewClient(sb.srv.URL, 5*time.Second)
	err := c.Convert(context.Background(), docx(), strings.NewReader("PK\x03\x04"), 4, 1<<20, func(io.Reader) error { return nil })
	if err == nil || hit.Load() {
		t.Fatalf("redirect followed or accepted: err=%v hit=%v", err, hit.Load())
	}
}

func TestRemembered_ExpiresAndIsBounded(t *testing.T) {
	svc, _, _, sha := newEnv(t, sandboxError(422, "unconvertible"))
	svc.cfg.FailureTTL = 50 * time.Millisecond
	_, _ = svc.Ensure(context.Background(), testOrg, sha, docx())
	if svc.Remembered(testOrg, sha, docx()) == nil {
		t.Fatal("failure not remembered")
	}
	time.Sleep(80 * time.Millisecond)
	if svc.Remembered(testOrg, sha, docx()) != nil {
		t.Fatal("failure outlived its TTL")
	}
	svc.cfg.FailureLimit = 3
	for i := 0; i < 20; i++ {
		svc.remember("k"+string(rune('a'+i)), ErrUnconvertible)
	}
	svc.mu.Lock()
	n := len(svc.fails)
	svc.mu.Unlock()
	if n > 3 {
		t.Fatalf("failure cache grew to %d, limit 3", n)
	}
}
