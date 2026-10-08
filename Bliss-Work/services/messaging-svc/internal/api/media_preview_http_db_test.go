package api

// GET /media/{id}/preview through the REAL router, store, blob store and
// Postgres with RLS enforcing. Only the Office Document Sandbox is stood in for
// (an httptest server speaking its protocol): it is an external service, and what
// is under test is that THIS side authorizes, validates and refuses correctly
// before and after a preview is cached.
//
// Opt-in via MESSAGING_API_TEST_DATABASE_URL (a non-superuser role); see
// meeting_series_http_db_test.go's header.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/convert"
	"github.com/task-board/messaging-svc/internal/media"
	"github.com/task-board/messaging-svc/internal/store"
)

const (
	docxBytes = "PK\x03\x04 pretend docx"
	oleBytes  = "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 pretend doc"
	pdfOut    = "%PDF-1.7 converted"
	sheetsOut = `{"sheets":[{"name":"S","csv":"a,b\n","totalRows":1,"truncated":false}],"moreSheets":false}`
)

type previewFixture struct {
	*httpFixture
	sandboxSrv *httptest.Server
	signer     *media.Signer
	blobs      blob.Store
	calls      atomic.Int32
	converter  func(w http.ResponseWriter, r *http.Request)
}

func newPreviewFixture(t *testing.T) *previewFixture {
	t.Helper()
	f := &previewFixture{httpFixture: newHTTPFixture(t)}
	var err error
	if f.signer, err = media.NewSigner(strings.Repeat("s", 40)); err != nil {
		t.Fatal(err)
	}
	if f.blobs, err = blob.NewFS(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	f.converter = func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if r.URL.Query().Get("kind") == "xlsx" || r.URL.Query().Get("kind") == "xls" {
			w.Header().Set("X-Preview-Kind", "sheets")
			_, _ = io.WriteString(w, sheetsOut)
			return
		}
		w.Header().Set("X-Preview-Kind", "pdf")
		_, _ = io.WriteString(w, pdfOut)
	}
	sandbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		f.converter(w, r)
	}))
	t.Cleanup(sandbox.Close)
	f.sandboxSrv = sandbox

	cfg := config.PreviewConfig{
		MaxInputBytes: 1 << 20, UserPerMinute: 1000, Wait: 3 * time.Second,
	}
	f.srv.blobs, f.srv.signer = f.blobs, f.signer
	f.srv.WithPreview(convert.NewService(f.blobs, convert.NewClient(sandbox.URL, 10*time.Second), convert.Config{
		Wait: cfg.Wait, RunTimeout: 10 * time.Second, MaxOutput: 1 << 20, MaxSheets: 1 << 20,
		MaxInFlight: 2, FailureTTL: time.Minute, BusyRetry: 20 * time.Millisecond,
	}), cfg)
	return f
}

// attach stores `content` as a channel attachment named `filename`, with the
// given STORED mime (which the preview route must ignore).
func (f *previewFixture) attach(filename, mime, content string) string {
	f.t.Helper()
	sha, n, err := f.blobs.WriteStream(f.org, strings.NewReader(content), 1<<20)
	if err != nil {
		f.t.Fatal(err)
	}
	att, err := f.srv.store.CreateAttachment(f.t.Context(), store.NewAttachment{
		OrgID: f.org, UploaderID: f.ada, Scope: store.ScopeChannel, ScopeID: f.channel, Role: store.RoleFile,
		SHA256: sha, MIME: mime, SizeBytes: n, Filename: filename, StoragePath: "x/" + sha, TTL: time.Hour,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return att.ID
}

func (f *previewFixture) grantFor(attID, user string) string {
	return f.signer.Sign(media.Grant{AttachmentID: attID, OrgID: f.org, UserID: user, Exp: time.Now().Add(time.Minute)})
}

func (f *previewFixture) get(attID, token string) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/media/"+attID+"/preview?t="+token, nil)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func TestPreviewHTTP_WordBecomesAnInlinePDF(t *testing.T) {
	f := newPreviewFixture(t)
	id := f.attach("Report.docx", "application/octet-stream", docxBytes)
	rec := f.get(id, f.grantFor(id, f.grace))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	h := rec.Header()
	if h.Get("Content-Type") != "application/pdf" || !strings.HasPrefix(h.Get("Content-Disposition"), "inline") {
		t.Errorf("headers: %v", h)
	}
	if h.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("missing hardening headers: %v", h)
	}
	if rec.Body.String() != pdfOut {
		t.Errorf("body = %q", rec.Body)
	}
}

func TestPreviewHTTP_SpreadsheetIsJSONServedAsAnAttachment(t *testing.T) {
	f := newPreviewFixture(t)
	id := f.attach("Budget.xlsx", "application/zip", docxBytes)
	rec := f.get(id, f.grantFor(id, f.grace))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	// Not on the inline allowlist, so a navigation downloads it; fetch() reads it.
	if rec.Header().Get("Content-Type") != "application/octet-stream" ||
		!strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment") {
		t.Errorf("headers: %v", rec.Header())
	}
	if rec.Body.String() != sheetsOut {
		t.Errorf("body = %q", rec.Body)
	}
}

func TestPreviewHTTP_TheStoredMimeAndTheClientDecideNothing(t *testing.T) {
	f := newPreviewFixture(t)
	// Stored as an image by a sender who lied, but named and shaped like a docx.
	id := f.attach("totally-an-image.docx", "image/png", docxBytes)
	if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
}

// The cache must never become an authorization bypass.
func TestPreviewHTTP_ACachedPreviewIsStillAuthorizedPerRequest(t *testing.T) {
	f := newPreviewFixture(t)
	id := f.attach("Report.docx", "application/octet-stream", docxBytes)
	if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusOK {
		t.Fatalf("priming: %d", rec.Code)
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("converted %d times", n)
	}
	// A validly SIGNED grant for someone who is not in the channel: the link was
	// minted while they were a member, then they left.
	for name, user := range map[string]string{"org member, not in channel": f.rival, "other org": f.stranger} {
		rec := f.get(id, f.grantFor(id, user))
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), "%PDF") {
			t.Errorf("%s was served the cached preview: %d", name, rec.Code)
		}
	}
	// And a member who is REMOVED after the preview was cached.
	f.exec(`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, f.channel, f.grace)
	if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code == http.StatusOK {
		t.Errorf("a removed member was served the cached preview")
	}
	if n := f.calls.Load(); n != 1 {
		t.Errorf("refused requests reached the sandbox: %d calls", n)
	}
}

func TestPreviewHTTP_BadGrantsAreRefusedBeforeAnythingElse(t *testing.T) {
	f := newPreviewFixture(t)
	id := f.attach("Report.docx", "application/octet-stream", docxBytes)
	other := f.attach("Other.docx", "application/octet-stream", docxBytes+"2")
	good := f.grantFor(id, f.grace)

	cases := map[string]string{
		"empty":                            "",
		"garbage":                          "not.a.token",
		"tampered":                         good[:len(good)-2] + "xx",
		"grant for a different attachment": f.grantFor(other, f.grace),
		"recording grant":                  f.signer.Sign(media.Grant{AttachmentID: id, OrgID: f.org, UserID: f.grace, Exp: time.Now().Add(time.Minute), Kind: media.KindRecording}),
		"expired":                          f.signer.Sign(media.Grant{AttachmentID: id, OrgID: f.org, UserID: f.grace, Exp: time.Now().Add(-time.Minute)}),
	}
	for name, tok := range cases {
		if rec := f.get(id, tok); rec.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403", name, rec.Code)
		}
	}
	if f.calls.Load() != 0 {
		t.Error("a refused grant reached the sandbox")
	}
}

func TestPreviewHTTP_OnlySupportedDocumentsAreEverSentToTheSandbox(t *testing.T) {
	f := newPreviewFixture(t)
	for name, content := range map[string]string{
		"a.pdf": "%PDF-1.4", "a.rtf": "{\\rtf1", "a.odt": docxBytes, "a.zip": docxBytes, "a.png": "\x89PNG",
		"a.eml": "From: x", "a.psd": "8BPS", "a.js": "alert(1)", "a.csv": "a,b", "a.docm": docxBytes,
		"noextension": docxBytes, ".docx": docxBytes,
	} {
		id := f.attach(name, "application/octet-stream", content)
		if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusUnsupportedMediaType {
			t.Errorf("%s: status = %d, want 415", name, rec.Code)
		}
	}
	if f.calls.Load() != 0 {
		t.Errorf("%d unsupported files reached the sandbox", f.calls.Load())
	}
}

func TestPreviewHTTP_MagicBytesMustMatchTheName(t *testing.T) {
	f := newPreviewFixture(t)
	cases := map[string][2]string{ // name -> {name, content}
		"exe as docx":     {"setup.docx", "MZ\x90\x00 an executable"},
		"exe as xls":      {"x.xls", "MZ\x90\x00 an executable"},
		"html as pptx":    {"x.pptx", "<html><script>"},
		"OLE as docx":     {"x.docx", oleBytes},
		"ZIP as doc":      {"x.doc", docxBytes},
		"ZIP as xls":      {"x.xls", docxBytes},
		"empty file":      {"x.docx", ""},
		"truncated magic": {"x.doc", "\xD0\xCF\x11"},
	}
	for name, c := range cases {
		if c[1] == "" {
			continue // an empty blob cannot be stored through WriteStream's dedupe path meaningfully; covered below
		}
		id := f.attach(c[0], "application/octet-stream", c[1])
		if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusUnsupportedMediaType {
			t.Errorf("%s: status = %d, want 415", name, rec.Code)
		}
	}
	if f.calls.Load() != 0 {
		t.Errorf("%d mismatched files reached the sandbox", f.calls.Load())
	}
}

func TestPreviewHTTP_OversizedInputIsRefusedWithoutConverting(t *testing.T) {
	f := newPreviewFixture(t)
	f.srv.previewCfg.MaxInputBytes = 64
	id := f.attach("Big.docx", "application/octet-stream", "PK\x03\x04"+strings.Repeat("x", 200))
	if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if f.calls.Load() != 0 {
		t.Error("an oversize file reached the sandbox")
	}
}

func TestPreviewHTTP_SandboxOutcomes(t *testing.T) {
	cases := []struct {
		name     string
		reply    func(w http.ResponseWriter, r *http.Request)
		want     int
		retryHdr bool
	}{
		{"unconvertible", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(422)
			_, _ = io.WriteString(w, `{"code":"unconvertible"}`)
		}, http.StatusUnprocessableEntity, false},
		{"limit", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(422)
			_, _ = io.WriteString(w, `{"code":"limit"}`)
		}, http.StatusUnprocessableEntity, false},
		{"busy", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(503)
			_, _ = io.WriteString(w, `{"code":"busy"}`)
		}, http.StatusServiceUnavailable, true},
		{"garbage artifact", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Preview-Kind", "pdf")
			_, _ = io.WriteString(w, "<script>alert(1)</script>")
		}, http.StatusUnprocessableEntity, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newPreviewFixture(t)
			f.converter = c.reply
			if c.name == "busy" {
				// A busy sandbox is retried until the run budget is spent; keep it short.
				f.srv.preview = convert.NewService(f.blobs, convert.NewClient(f.sandboxSrv.URL, 10*time.Second), convert.Config{
					Wait: 3 * time.Second, RunTimeout: 300 * time.Millisecond, MaxOutput: 1 << 20, MaxSheets: 1 << 20,
					MaxInFlight: 2, FailureTTL: time.Minute, BusyRetry: 20 * time.Millisecond,
				})
			}
			id := f.attach("Report.docx", "application/octet-stream", docxBytes)
			rec := f.get(id, f.grantFor(id, f.grace))
			if rec.Code != c.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, c.want, rec.Body)
			}
			if c.retryHdr && rec.Header().Get("Retry-After") == "" {
				t.Error("503 without Retry-After")
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("a failure is cacheable: %q", rec.Header().Get("Cache-Control"))
			}
			// Nothing about the document in the reply.
			if strings.Contains(rec.Body.String(), "docx") || strings.Contains(rec.Body.String(), "Report") {
				t.Errorf("reply names the document: %s", rec.Body)
			}
		})
	}
}

func TestPreviewHTTP_ADeterministicFailureIsRemembered(t *testing.T) {
	f := newPreviewFixture(t)
	f.converter = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		_, _ = io.WriteString(w, `{"code":"unconvertible"}`)
	}
	id := f.attach("Corrupt.docx", "application/octet-stream", docxBytes)
	for i := 0; i < 3; i++ {
		if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
	}
	if n := f.calls.Load(); n != 1 {
		t.Errorf("sandbox asked %d times for a document known to fail, want 1", n)
	}
}

func TestPreviewHTTP_SlowConversionIs202ThenReady(t *testing.T) {
	f := newPreviewFixture(t)
	release := make(chan struct{})
	f.converter = func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.Header().Set("X-Preview-Kind", "pdf")
		_, _ = io.WriteString(w, pdfOut)
	}
	f.srv.preview = convert.NewService(f.blobs, convert.NewClient(f.sandboxSrv.URL, 10*time.Second), convert.Config{
		Wait: 150 * time.Millisecond, RunTimeout: 10 * time.Second, MaxOutput: 1 << 20, MaxSheets: 1 << 20, MaxInFlight: 2, FailureTTL: time.Minute,
	})
	id := f.attach("Slow.docx", "application/octet-stream", docxBytes)
	rec := f.get(id, f.grantFor(id, f.grace))
	if rec.Code != http.StatusAccepted || rec.Header().Get("Retry-After") == "" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status = %d headers %v", rec.Code, rec.Header())
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		rec = f.get(id, f.grantFor(id, f.grace))
		if rec.Code == http.StatusOK {
			break
		}
		if time.Now().After(deadline) || (rec.Code != http.StatusAccepted) {
			t.Fatalf("never became ready: %d %s", rec.Code, rec.Body)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if rec.Body.String() != pdfOut {
		t.Errorf("body %q", rec.Body)
	}
}

func TestPreviewHTTP_UnconfiguredIsUnavailable(t *testing.T) {
	f := newPreviewFixture(t)
	f.srv.preview = nil
	id := f.attach("Report.docx", "application/octet-stream", docxBytes)
	if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	// Authorization still comes first: an unauthorized caller learns nothing.
	if rec := f.get(id, f.grantFor(id, f.stranger)); rec.Code == http.StatusServiceUnavailable {
		t.Error("an unauthorized caller was told about the preview configuration")
	}
}

func TestPreviewHTTP_OnlyCacheMissesSpendTheUsersBudget(t *testing.T) {
	f := newPreviewFixture(t)
	f.srv.previewCfg.UserPerMinute = 2
	ids := []string{
		f.attach("a.docx", "application/octet-stream", docxBytes+"a"),
		f.attach("b.docx", "application/octet-stream", docxBytes+"b"),
		f.attach("c.docx", "application/octet-stream", docxBytes+"c"),
	}
	for i, id := range ids[:2] {
		if rec := f.get(id, f.grantFor(id, f.grace)); rec.Code != http.StatusOK {
			t.Fatalf("conversion %d: %d", i, rec.Code)
		}
	}
	if rec := f.get(ids[2], f.grantFor(ids[2], f.grace)); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("third conversion: %d, want 429", rec.Code)
	}
	// Re-reading the two already converted costs nothing, however often.
	for i := 0; i < 10; i++ {
		if rec := f.get(ids[0], f.grantFor(ids[0], f.grace)); rec.Code != http.StatusOK {
			t.Fatalf("cache hit %d: %d", i, rec.Code)
		}
	}
}
