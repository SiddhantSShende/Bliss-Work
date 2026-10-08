package middleware_test

// The idempotency claim against a REAL Postgres, behind the real JWT verifier.
//
// Opt-in on its own database variable (each package's test binary migrates the
// schema; two doing it at once against one database would deadlock). The role
// must be a plain login role:
//
//	MESSAGING_MW_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/mw_test' \
//	  go test ./internal/middleware/ -run TestIdempotency -v

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/crypto"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/migrations"
)

type idemFixture struct {
	t     *testing.T
	pool  *pgxpool.Pool
	priv  ed25519.PrivateKey
	user  string
	calls atomic.Int32
	// handler is swapped per test; it runs behind verifier -> Idempotency.
	handler http.HandlerFunc
	srv     *httptest.Server
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func newIdemFixture(t *testing.T) *idemFixture {
	t.Helper()
	url := os.Getenv("MESSAGING_MW_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("MESSAGING_MW_TEST_DATABASE_URL not set; see the header of this file")
	}
	ctx := context.Background()
	f := &idemFixture{t: t, user: uuid.NewString()}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.priv = priv
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"keys":[{"kty":"OKP","crv":"Ed25519","x":%q,"kid":"t","alg":"EdDSA","use":"sig"}]}`, b64(pub))
	}))
	t.Cleanup(jwks.Close)
	verifier, err := auth.NewVerifier(ctx, jwks.URL, "task-board")
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}

	kek, err := crypto.NewDevKEKProvider("idem-test-passphrase", []byte("0123456789abcdef"), 1)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.New(ctx, url, crypto.New(kek, time.Minute))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(st.Close)
	// Twice on purpose: the migration set (0034 included) must be re-runnable.
	for i := 0; i < 2; i++ {
		if err := st.Migrate(ctx); err != nil {
			t.Fatalf("migrate (run %d): %v", i+1, err)
		}
	}
	f.pool = st.Pool()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	chain := verifier.Middleware(mw.Idempotency(f.pool, log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		f.handler(w, r)
	})))
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Stand-in for the app's recoverer, which answers 500 for a panic.
		defer func() {
			if rec := recover(); rec != nil {
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		chain.ServeHTTP(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *idemFixture) token() string {
	head := b64([]byte(`{"alg":"EdDSA","typ":"JWT","kid":"t"}`))
	now := time.Now().Unix()
	body, _ := json.Marshal(map[string]any{
		"iss": "task-board", "sub": f.user, "org_id": uuid.NewString(), "username": "u",
		"roles": []string{"member"}, "iat": now, "exp": now + 3600,
	})
	signing := head + "." + b64(body)
	return signing + "." + b64(ed25519.Sign(f.priv, []byte(signing)))
}

func (f *idemFixture) post(path, key string) (int, string, http.Header) {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.srv.URL+path, strings.NewReader(""))
	req.Header.Set("Authorization", "Bearer "+f.token())
	req.Header.Set("Idempotency-Key", key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), resp.Header
}

func (f *idemFixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), q, args...); err != nil {
		f.t.Fatalf("%s: %v", q, err)
	}
}

func okNoContent(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }

// The normal path is unchanged, and a replay of a finished request returns the
// original response (not a bare 204) without running the handler again.
func TestIdempotencyReplayReturnsStoredResponse(t *testing.T) {
	f := newIdemFixture(t)
	f.handler = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"abc"}`))
	}
	key := uuid.NewString()
	code, body, _ := f.post("/mail/drafts/1/send", key)
	if code != 201 || body != `{"id":"abc"}` {
		t.Fatalf("first call = %d %q", code, body)
	}
	code, body, h := f.post("/mail/drafts/1/send", key)
	if code != 201 || body != `{"id":"abc"}` || h.Get("Content-Type") != "application/json" {
		t.Fatalf("replay = %d %q %v", code, body, h)
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("handler ran %d times, want 1", n)
	}
}

// B-MSG-4: a duplicate arriving while the original is still running must not be
// told 204 ("done"); and when the original then fails, the key is free again.
func TestIdempotencyDuplicateWhileInFlightIsConflictThenRetryable(t *testing.T) {
	f := newIdemFixture(t)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock) // a failed assertion must not leave the handler (and the server) hanging
	var fail atomic.Bool
	fail.Store(true)
	f.handler = func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			close(started)
			<-release
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
	key := uuid.NewString()
	first := make(chan int, 1)
	go func() { c, _, _ := f.post("/threads/x/ignore", key); first <- c }()
	<-started

	code, _, h := f.post("/threads/x/ignore", key)
	if code != http.StatusConflict {
		t.Fatalf("duplicate while in flight = %d, want 409", code)
	}
	if h.Get("Retry-After") == "" {
		t.Fatal("409 should carry Retry-After")
	}
	unblock()
	if c := <-first; c != 500 {
		t.Fatalf("original = %d, want 500", c)
	}

	// The original failed, so the claim was released: a retry really runs.
	fail.Store(false)
	if code, _, _ := f.post("/threads/x/ignore", key); code != 204 {
		t.Fatalf("retry after failed original = %d, want 204", code)
	}
	if n := f.calls.Load(); n != 2 {
		t.Fatalf("handler ran %d times, want 2 (original + retry)", n)
	}
}

// B-MSG-4: a claim left behind by a crashed handler is taken over once stale
// instead of turning every retry into a silent no-op for 24h.
func TestIdempotencyStaleClaimIsTakenOver(t *testing.T) {
	f := newIdemFixture(t)
	f.handler = okNoContent

	staleKey, freshKey := uuid.NewString(), uuid.NewString()
	f.exec(`INSERT INTO idempotency_keys (user_id, key, route, state, updated_at)
	        VALUES ($1, $2, 'POST /threads/x/ignore', 'in_progress', now() - interval '10 minutes')`, f.user, staleKey)
	f.exec(`INSERT INTO idempotency_keys (user_id, key, route, state, updated_at)
	        VALUES ($1, $2, 'POST /threads/x/ignore', 'in_progress', now())`, f.user, freshKey)

	if code, _, _ := f.post("/threads/x/ignore", staleKey); code != 204 {
		t.Fatalf("stale takeover = %d, want 204", code)
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("handler ran %d times after takeover, want 1", n)
	}
	// ...and it completed, so the next one is an ordinary replay.
	if code, _, _ := f.post("/threads/x/ignore", staleKey); code != 204 || f.calls.Load() != 1 {
		t.Fatalf("replay after takeover ran the handler again (calls=%d)", f.calls.Load())
	}
	if code, _, _ := f.post("/threads/x/ignore", freshKey); code != http.StatusConflict {
		t.Fatalf("fresh in-progress claim = %d, want 409", code)
	}
}

// B-MSG-4: a key is bound to the request that claimed it.
func TestIdempotencyKeyIsBoundToItsRoute(t *testing.T) {
	f := newIdemFixture(t)
	f.handler = okNoContent
	key := uuid.NewString()
	if code, _, _ := f.post("/threads/a/ignore", key); code != 204 {
		t.Fatalf("first = %d", code)
	}
	code, body, _ := f.post("/threads/b/ignore", key)
	if code != http.StatusUnprocessableEntity || !strings.Contains(body, "different request") {
		t.Fatalf("other route = %d %q, want 422", code, body)
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("handler ran %d times, want 1", n)
	}
}

// Existing behaviour kept: a non-2xx releases the claim; so does a panic.
func TestIdempotencyFailedOrPanickedHandlerReleasesClaim(t *testing.T) {
	f := newIdemFixture(t)
	mode := "fail"
	f.handler = func(w http.ResponseWriter, _ *http.Request) {
		switch mode {
		case "fail":
			w.WriteHeader(http.StatusBadRequest)
		case "panic":
			panic("boom")
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}
	key := uuid.NewString()
	if code, _, _ := f.post("/threads/x/ignore", key); code != 400 {
		t.Fatalf("fail = %d", code)
	}
	mode = "panic"
	if code, _, _ := f.post("/threads/x/ignore", key); code != 500 {
		t.Fatalf("panic = %d", code)
	}
	mode = "ok"
	if code, _, _ := f.post("/threads/x/ignore", key); code != 204 {
		t.Fatalf("retry after panic = %d, want 204 (claim must have been released)", code)
	}
	if n := f.calls.Load(); n != 3 {
		t.Fatalf("handler ran %d times, want 3", n)
	}
}

// Rolling deploy: a row written by the previous release (user_id + key only)
// reads as a finished claim and replays as 204, as it always did.
func TestIdempotencyLegacyRowReplaysAsNoContent(t *testing.T) {
	f := newIdemFixture(t)
	f.handler = okNoContent
	key := uuid.NewString()
	f.exec(`INSERT INTO idempotency_keys (user_id, key) VALUES ($1, $2)`, f.user, key)
	code, body, _ := f.post("/anything/at/all", key)
	if code != 204 || body != "" || f.calls.Load() != 0 {
		t.Fatalf("legacy replay = %d %q calls=%d", code, body, f.calls.Load())
	}
}

// The migration file itself can be re-applied (Migrate re-runs an edited file).
func TestIdempotencyMigrationIsReapplicable(t *testing.T) {
	f := newIdemFixture(t)
	sql, err := migrations.FS.ReadFile("0034_idempotency_state.sql")
	if err != nil {
		t.Fatal(err)
	}
	f.exec(string(sql))
	f.exec(string(sql))
}
