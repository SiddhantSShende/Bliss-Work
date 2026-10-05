package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
	"github.com/task-board/notification-svc/internal/auth"
	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
)

const testIssuer = "test-issuer"

// testEnv is the REAL router — real JWT verification against a JWKS endpoint,
// real handlers, real Postgres — so behaviour is covered end to end, not just as SQL.
type testEnv struct {
	pool  *pgxpool.Pool
	url   string
	orgID string
	sign  func(userID string) string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dsn := os.Getenv("NOTIFICATION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTIFICATION_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect notification test DB: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate notification test DB: %v", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubKey, _ := jwk.FromRaw(pub)
	_ = pubKey.Set(jwk.KeyIDKey, "k1")
	_ = pubKey.Set(jwk.AlgorithmKey, jwa.EdDSA)
	set := jwk.NewSet()
	_ = set.AddKey(pubKey)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(jwks.Close)
	verifier, err := auth.NewVerifier(ctx, jwks.URL, testIssuer)
	if err != nil {
		t.Fatal(err)
	}
	signKey, _ := jwk.FromRaw(priv)
	_ = signKey.Set(jwk.KeyIDKey, "k1")

	env := &testEnv{pool: pool, orgID: uuid.NewString()}
	server := New(pool, verifier, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	api := httptest.NewServer(server.Router())
	t.Cleanup(api.Close)
	env.url = api.URL
	env.sign = func(userID string) string {
		tok, err := jwt.NewBuilder().Issuer(testIssuer).Subject(userID).
			Expiration(time.Now().Add(time.Hour)).Claim("org_id", env.orgID).Build()
		if err != nil {
			t.Fatal(err)
		}
		signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, signKey))
		if err != nil {
			t.Fatal(err)
		}
		return string(signed)
	}
	return env
}

func listHarness(t *testing.T) (call func(token, query string) (int, notificationPageDTO), tokenFor func(userID string) string, seed func(userID string, text string, read bool, at time.Time)) {
	t.Helper()
	env := newTestEnv(t)
	call = func(token, query string) (int, notificationPageDTO) {
		req, _ := http.NewRequest(http.MethodGet, env.url+"/api/v1/notifications"+query, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var page notificationPageDTO
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
				t.Fatalf("decode page: %v", err)
			}
		}
		return resp.StatusCode, page
	}
	seed = func(userID, text string, read bool, at time.Time) {
		var readAt interface{}
		if read {
			readAt = at
		}
		if _, err := env.pool.Exec(context.Background(),
			`INSERT INTO notifications (id, org_id, recipient_id, kind, text, read_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			uuid.New(), env.orgID, userID, events.KindChannelAdded, text, readAt, at); err != nil {
			t.Fatalf("seed notification: %v", err)
		}
	}
	return call, env.sign, seed
}

// walk follows nextCursor to the end with the given page size, returning every
// text in the order served.
func walk(t *testing.T, call func(string, string) (int, notificationPageDTO), token, filter string, limit string) []string {
	t.Helper()
	var texts []string
	cursor := ""
	for pages := 0; pages < 20; pages++ {
		q := "?limit=" + limit + filter
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		status, page := call(token, q)
		if status != http.StatusOK {
			t.Fatalf("GET %s = %d", q, status)
		}
		for _, n := range page.Items {
			texts = append(texts, n.Text)
		}
		if page.NextCursor == nil {
			return texts
		}
		cursor = *page.NextCursor
	}
	t.Fatal("pagination did not terminate")
	return nil
}

func TestListHTTPReadFilterAndPagination(t *testing.T) {
	call, tokenFor, seed := listHarness(t)
	me, other := uuid.NewString(), uuid.NewString()
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	// Newest first: u1 r1 r2 u2 r3 u3 r4 (read and unread interleaved).
	order := []struct {
		text string
		read bool
	}{{"u1", false}, {"r1", true}, {"r2", true}, {"u2", false}, {"r3", true}, {"u3", false}, {"r4", true}}
	for i, n := range order {
		seed(me, n.text, n.read, base.Add(time.Duration(len(order)-i)*time.Minute))
	}
	seed(other, "someone-else", false, base) // another recipient's row never leaks in
	token := tokenFor(me)

	cases := []struct {
		name, filter string
		want         []string
	}{
		{"unread only", "&read=false", []string{"u1", "u2", "u3"}},
		{"read only", "&read=true", []string{"r1", "r2", "r3", "r4"}},
		{"omitted = all", "", []string{"u1", "r1", "r2", "u2", "r3", "u3", "r4"}},
	}
	for _, tc := range cases {
		for _, limit := range []string{"2", "50"} {
			got := walk(t, call, token, tc.filter, limit)
			if !slices.Equal(got, tc.want) {
				t.Errorf("%s (limit=%s): got %v, want %v", tc.name, limit, got, tc.want)
			}
		}
	}

	// The filter is reflected in each row's own state, and the first page of an
	// unread request is unread rows even though the newest READ rows precede
	// u2/u3 in time.
	_, page := call(token, "?limit=2&read=false")
	if len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("read=false limit=2: %d items, cursor %v", len(page.Items), page.NextCursor)
	}
	for _, n := range page.Items {
		if n.Read {
			t.Errorf("read=false returned read row %q", n.Text)
		}
	}
	_, page = call(token, "?limit=10&read=true")
	for _, n := range page.Items {
		if !n.Read {
			t.Errorf("read=true returned unread row %q", n.Text)
		}
	}
}

func TestListHTTPRejectsInvalidReadFilter(t *testing.T) {
	call, tokenFor, _ := listHarness(t)
	token := tokenFor(uuid.NewString())
	for _, bad := range []string{"foo", "1", "TRUE", "yes"} {
		if status, _ := call(token, "?limit=10&read="+bad); status != http.StatusBadRequest {
			t.Errorf("read=%s = %d, want 400", bad, status)
		}
	}
	if status, _ := call(token, "?limit=10&read=false"); status != http.StatusOK {
		t.Errorf("read=false = %d, want 200", status)
	}
	if status, _ := call("not-a-token", "?limit=10"); status != http.StatusUnauthorized {
		t.Errorf("bad token = %d, want 401", status)
	}
}
