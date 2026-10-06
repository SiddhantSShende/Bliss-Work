package api

// Repeating meetings through the REAL router: the real auth middleware (an EdDSA JWT
// checked against a JWKS endpoint), the real handlers and store, and Postgres with RLS
// enforcing. This is the test that shows authorization holds against hand-built
// requests, and that counts what actually reaches the outbox.
//
// Opt-in, on its OWN database variable so it can never run its migrations concurrently
// with the store package's tests (each package's test binary migrates the schema, and two
// doing it at once against one database deadlock):
//
//	MESSAGING_API_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/api_test' \
//	  go test ./internal/api/ -run TestSeriesHTTP -v
//
// The role must NOT be a superuser or BYPASSRLS role — RLS is skipped for those, which
// would make every cross-org assertion below pass for the wrong reason.

import (
	"bytes"
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
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/migrations"
)

type httpFixture struct {
	t        *testing.T
	srv      *Server
	router   http.Handler
	conn     *pgx.Conn
	priv     ed25519.PrivateKey
	org      string
	other    string
	host     string
	ada      string
	grace    string
	rival    string
	stranger string
	channel  string
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func newHTTPFixture(t *testing.T) *httpFixture {
	t.Helper()
	url := os.Getenv("MESSAGING_API_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("MESSAGING_API_TEST_DATABASE_URL not set; see the header of this file")
	}
	ctx := context.Background()
	f := &httpFixture{t: t}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(ctx) })
	f.conn = conn
	var privileged bool
	if err := conn.QueryRow(ctx, `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&privileged); err != nil {
		t.Fatalf("read role: %v", err)
	}
	if privileged {
		t.Fatal("the database role bypasses RLS; every cross-org assertion here would pass for the wrong reason")
	}
	f.migrate()

	// A signer the service trusts.
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

	kek, err := crypto.NewDevKEKProvider("api-http-test-passphrase", []byte("0123456789abcdef"), 1)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.New(ctx, url, crypto.New(kek, time.Minute))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(st.Close)
	f.srv = NewServer(st, verifier, slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil, nil, config.MediaConfig{MaxBytes: 100 << 20}, config.MapsConfig{}, nil)
	f.router = f.srv.Router("http://localhost:5173")

	f.org, f.other = uuid.NewString(), uuid.NewString()
	f.host, f.ada, f.grace, f.rival = uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	f.stranger = uuid.NewString()
	for i, u := range []struct{ id, org string }{{f.host, f.org}, {f.ada, f.org}, {f.grace, f.org}, {f.rival, f.org}, {f.stranger, f.other}} {
		f.exec(`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1, $2, $3, $3)`,
			u.id, u.org, fmt.Sprintf("u%d-%s", i, u.id[:6]))
	}
	f.channel = f.newChannel(f.org, f.host, f.ada, f.grace)
	return f
}

func (f *httpFixture) migrate() {
	ctx := context.Background()
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		f.t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	// A session lock, so even two of these against one database serialise.
	if _, err := f.conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('messaging-api-test-migrate'))`); err != nil {
		f.t.Fatal(err)
	}
	defer f.conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtext('messaging-api-test-migrate'))`) //nolint:errcheck
	for _, n := range names {
		body, _ := migrations.FS.ReadFile(n)
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			f.t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
			f.t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			f.t.Fatalf("apply %s: %v", n, err)
		}
		if err := tx.Commit(ctx); err != nil {
			f.t.Fatal(err)
		}
	}
}

// exec runs fixture SQL under bypass — there is no caller here.
func (f *httpFixture) exec(sql string, args ...any) {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		f.t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		f.t.Fatalf("fixture SQL: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		f.t.Fatal(err)
	}
}

func (f *httpFixture) count(sql string, args ...any) int {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, _ = tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
	var n int
	if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatalf("count: %v", err)
	}
	return n
}

func (f *httpFixture) newChannel(org string, owner string, members ...string) string {
	f.t.Helper()
	id := uuid.NewString()
	f.exec(`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1, $2, 'general', $3)`, id, org, owner)
	for _, m := range append([]string{owner}, members...) {
		f.exec(`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, id, org, m)
	}
	return id
}

// token signs a JWT for (user, org) that the service's verifier accepts.
func (f *httpFixture) token(user, org string) string {
	head := b64([]byte(`{"alg":"EdDSA","typ":"JWT","kid":"t"}`))
	now := time.Now().Unix()
	body, _ := json.Marshal(map[string]any{
		"iss": "task-board", "sub": user, "org_id": org, "username": "u", "roles": []string{"member"},
		"iat": now, "exp": now + 3600,
	})
	signing := head + "." + b64(body)
	return signing + "." + b64(ed25519.Sign(f.priv, []byte(signing)))
}

// do sends a request through the real router.
func (f *httpFixture) do(method, path, token string, body any) (int, []byte) {
	f.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			f.t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

func (f *httpFixture) as(user, org string) func(method, path string, body any) (int, []byte) {
	tok := f.token(user, org)
	return func(method, path string, body any) (int, []byte) { return f.do(method, path, tok, body) }
}

// events reports this fixture's org's outbox events of one type, oldest first, as their
// recipient lists. Scoped to the org because the outbox is shared by every test in the
// database.
func (f *httpFixture) events(typ string) [][]string {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, _ = tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
	rows, err := tx.Query(ctx, `SELECT payload->'members' FROM outbox
		WHERE payload->>'type' = $1 AND payload->>'orgId' = $2 ORDER BY created_at, id`, typ, f.org)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			f.t.Fatal(err)
		}
		var m []string
		_ = json.Unmarshal(raw, &m)
		sort.Strings(m)
		out = append(out, m)
	}
	return out
}

func decode[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return v
}

type callResp struct {
	ID         string   `json:"id"`
	Status     string   `json:"status"`
	ChannelIDs []string `json:"channelIds"`
	Series     *struct {
		ID         string `json:"id"`
		Status     string `json:"status"`
		Recurrence struct {
			Frequency string `json:"frequency"`
			Interval  int    `json:"interval"`
			Weekdays  []int  `json:"weekdays"`
			TimeZone  string `json:"timeZone"`
		} `json:"recurrence"`
	} `json:"series"`
	Participants []struct {
		UserID string `json:"userId"`
	} `json:"participants"`
}

type seriesResp struct {
	ID         string   `json:"id"`
	Status     string   `json:"status"`
	Title      string   `json:"title"`
	InviteeIDs []string `json:"inviteeIds"`
	ChannelIDs []string `json:"channelIds"`
}

func nextMonday10() time.Time {
	d := time.Now().UTC().AddDate(0, 0, 2)
	for d.Weekday() != time.Monday {
		d = d.AddDate(0, 0, 1)
	}
	return time.Date(d.Year(), d.Month(), d.Day(), 10, 0, 0, 0, time.UTC)
}

func (f *httpFixture) weeklyBody(extra map[string]any) map[string]any {
	b := map[string]any{
		"title": "Weekly review", "media": "video", "scheduledAt": nextMonday10().Format(time.RFC3339),
		"durationMinutes": 60,
		"recurrence": map[string]any{
			"frequency": "WEEKLY", "interval": 1, "weekdays": []int{0, 2, 4}, "endCondition": "NO_END", "timeZone": "Europe/Berlin",
		},
	}
	for k, v := range extra {
		b[k] = v
	}
	return b
}

// ── Authentication and authorization, against hand-built requests ───────────────

func TestSeriesHTTP_AuthorizationCannotBeBypassedWithHandBuiltRequests(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)

	code, raw := host("POST", "/api/v1/meetings", f.weeklyBody(map[string]any{"inviteeIds": []string{f.ada}, "channelIds": []string{f.channel}}))
	if code != http.StatusCreated {
		t.Fatalf("create = %d %s", code, raw)
	}
	created := decode[callResp](t, raw)
	sid := created.Series.ID
	path := "/api/v1/meeting-series/" + sid

	t.Run("no token is 401 on every verb", func(t *testing.T) {
		for _, m := range []string{"GET", "PATCH", "DELETE"} {
			if code, _ := f.do(m, path, "", `{}`); code != http.StatusUnauthorized {
				t.Errorf("%s without a token = %d", m, code)
			}
		}
	})
	t.Run("a garbage or forged token is 401", func(t *testing.T) {
		forged := f.token(f.host, f.org)
		forged = forged[:len(forged)-4] + "AAAA" // signature tampered
		for _, tok := range []string{"garbage", "a.b.c", forged} {
			if code, _ := f.do("GET", path, tok, nil); code != http.StatusUnauthorized {
				t.Errorf("token %q = %d", tok[:min(len(tok), 12)], code)
			}
		}
	})
	t.Run("a token claiming the org of a series it does not own", func(t *testing.T) {
		// The org comes from the SIGNED claim, so an attacker cannot name the victim's
		// org; the best they can do is present the victim's series id with their own.
		for name, who := range map[string]func(string, string, any) (int, []byte){
			"an invitee":                    f.as(f.ada, f.org),
			"a colleague on no roster":      f.as(f.rival, f.org),
			"a member of another org":       f.as(f.stranger, f.other),
			"a channel member, not invited": f.as(f.grace, f.org),
		} {
			if code, _ := who("GET", path, nil); code != http.StatusForbidden {
				t.Errorf("%s GET = %d, want 403", name, code)
			}
			if code, _ := who("PATCH", path, map[string]any{"title": "hijack"}); code != http.StatusForbidden {
				t.Errorf("%s PATCH = %d, want 403", name, code)
			}
			if code, _ := who("DELETE", path, nil); code != http.StatusForbidden {
				t.Errorf("%s DELETE = %d, want 403", name, code)
			}
		}
		if n := f.count(`SELECT count(*) FROM calls WHERE series_id = $1 AND status = 'SCHEDULED'`, sid); n == 0 {
			t.Error("refused requests removed the series' occurrences")
		}
		code, raw := host("GET", path, nil)
		if code != 200 || decode[seriesResp](t, raw).Title != "Weekly review" || decode[seriesResp](t, raw).Status != "ACTIVE" {
			t.Errorf("the series changed under refused requests: %d %s", code, raw)
		}
	})
	t.Run("an unknown series id is the SAME 403 as somebody else's", func(t *testing.T) {
		for _, m := range []string{"GET", "PATCH", "DELETE"} {
			if code, _ := host(m, "/api/v1/meeting-series/"+uuid.NewString(), `{"title":"x"}`); code != http.StatusForbidden {
				t.Errorf("%s of an unknown series = %d, want 403", m, code)
			}
		}
		if code, _ := host("GET", "/api/v1/meeting-series/not-a-uuid", nil); code != http.StatusBadRequest {
			t.Errorf("a malformed id = %d, want 400", code)
		}
	})
}

// Everything a client could send that names something it is not entitled to.
func TestSeriesHTTP_UninvitablePeopleAndChannelsAreRefused(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	private := f.newChannel(f.org, f.ada, f.grace) // host is not in it
	deleted := f.newChannel(f.org, f.host, f.ada)
	f.exec(`DELETE FROM channels WHERE id = $1`, deleted)
	inactive := uuid.NewString()
	f.exec(`INSERT INTO user_projection (user_id, org_id, username, display_name, active) VALUES ($1, $2, 'gone', 'gone', false)`, inactive, f.org)
	blocked := uuid.NewString()
	f.exec(`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1, $2, 'blk', 'blk')`, blocked, f.org)
	low, high := f.host, blocked
	if low > high {
		low, high = high, low
	}
	convo := uuid.NewString()
	f.exec(`INSERT INTO conversations (id, org_id, user_low, user_high) VALUES ($1, $2, $3, $4)`, convo, f.org, low, high)
	f.exec(`INSERT INTO conversation_members (conversation_id, org_id, user_id, blocked) VALUES ($1, $2, $3, true)`, convo, f.org, blocked)

	cases := map[string]map[string]any{
		"a channel the organiser is not in": {"channelIds": []string{private}},
		"a deleted channel":                 {"channelIds": []string{deleted}},
		"another organisation's channel":    {"channelIds": []string{f.newChannel(f.other, f.stranger)}},
		"a deleted member":                  {"inviteeIds": []string{uuid.NewString()}},
		"an inactive member":                {"inviteeIds": []string{inactive}},
		"a blocked member":                  {"inviteeIds": []string{blocked}},
		"another organisation's member":     {"inviteeIds": []string{f.stranger}},
	}
	for name, extra := range cases {
		if code, raw := host("POST", "/api/v1/meetings", f.weeklyBody(extra)); code != http.StatusForbidden {
			t.Errorf("create with %s = %d %s, want 403", name, code, raw)
		}
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE org_id = $1`, f.org); n != 0 {
		t.Errorf("%d calls were written by refused requests", n)
	}
}

// Requests built to get past client-side checks the server must repeat.
func TestSeriesHTTP_MalformedAndAbusiveBodiesAreRefused(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	rec := func(over map[string]any) map[string]any {
		r := map[string]any{"frequency": "WEEKLY", "interval": 1, "weekdays": []int{0}, "endCondition": "NO_END", "timeZone": "UTC"}
		for k, v := range over {
			r[k] = v
		}
		return r
	}
	manyDays := make([]int, 20000)
	bad := map[string]any{
		"20000 weekdays":                    f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"weekdays": manyDays})}),
		"interval 1000000":                  f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"interval": 1000000})}),
		"a negative interval":               f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"interval": -3})}),
		"a time zone that is a path":        f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"timeZone": "../../etc/passwd"})}),
		"the server's own zone":             f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"timeZone": "Local"})}),
		"a 5000-character time zone":        f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"timeZone": strings.Repeat("A", 5000)})}),
		"an end date far in the future":     f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"endCondition": "ON_DATE", "endDate": "9999-12-31"})}),
		"an occurrence count of a billion":  f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"endCondition": "AFTER_OCCURRENCES", "occurrenceCount": 1000000000})}),
		"weekly with weekdays out of range": f.weeklyBody(map[string]any{"recurrence": rec(map[string]any{"weekdays": []int{9}})}),
		"a repeat with no start time":       map[string]any{"title": "x", "recurrence": rec(nil)},
		"a repeat starting in the past":     f.weeklyBody(map[string]any{"scheduledAt": time.Now().Add(-48 * time.Hour).Format(time.RFC3339)}),
		"201 invitees":                      f.weeklyBody(map[string]any{"inviteeIds": manyIDs(201)}),
		"21 channels":                       f.weeklyBody(map[string]any{"channelIds": manyIDs(21)}),
		"a channel id that is not a uuid":   f.weeklyBody(map[string]any{"channelIds": []string{"'; DROP TABLE calls;--"}}),
		"the same invitee twice":            f.weeklyBody(map[string]any{"inviteeIds": []string{f.ada, strings.ToUpper(f.ada)}}),
	}
	for name, body := range bad {
		if code, raw := host("POST", "/api/v1/meetings", body); code != http.StatusBadRequest {
			t.Errorf("%s = %d %.120s, want 400", name, code, raw)
		}
	}
	if code, _ := host("POST", "/api/v1/meetings", `{"title": `); code != http.StatusBadRequest {
		t.Errorf("malformed JSON = %d, want 400", code)
	}
	if code, _ := host("POST", "/api/v1/meetings", bytes.Repeat([]byte("a"), 3<<20)); code != http.StatusRequestEntityTooLarge && code != http.StatusBadRequest {
		t.Errorf("a 3 MiB body = %d, want it refused", code)
	}
	if code, _ := host("PATCH", "/api/v1/meeting-series/"+uuid.NewString(), `{}`); code != http.StatusBadRequest && code != http.StatusForbidden {
		t.Errorf("an empty PATCH = %d", code)
	}
	if n := f.count(`SELECT count(*) FROM calls WHERE org_id = $1`, f.org); n != 0 {
		t.Errorf("%d calls were written by refused requests", n)
	}
}

func manyIDs(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = uuid.NewString()
	}
	return out
}

// ── Notifications: exactly what reaches the outbox ──────────────────────────────

func TestSeriesHTTP_NotificationsAreSentOnceAndOnlyToWhoNeedThem(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	ch1 := f.newChannel(f.org, f.host, f.grace)
	ch2 := f.newChannel(f.org, f.host, f.grace) // grace is in BOTH channels
	sorted := func(ids ...string) []string { sort.Strings(ids); return ids }

	code, raw := host("POST", "/api/v1/meetings", f.weeklyBody(map[string]any{"inviteeIds": []string{f.ada}}))
	if code != http.StatusCreated {
		t.Fatalf("create = %d %s", code, raw)
	}
	sid := decode[callResp](t, raw).Series.ID
	occurrences := f.count(`SELECT count(*) FROM calls WHERE series_id = $1`, sid)
	if occurrences < 12 {
		t.Fatalf("only %d occurrences", occurrences)
	}

	t.Run("creating announces ONCE, however many occurrences it wrote", func(t *testing.T) {
		got := f.events("call.scheduled")
		if len(got) != 1 {
			t.Fatalf("%d call.scheduled events for a series of %d occurrences, want 1", len(got), occurrences)
		}
		if strings.Join(got[0], ",") != strings.Join(sorted(f.host, f.ada), ",") {
			t.Errorf("recipients = %v", got[0])
		}
	})

	t.Run("the sweeper writing occurrences later announces nothing", func(t *testing.T) {
		before := len(f.events("call.scheduled"))
		f.exec(`UPDATE call_series SET next_start_at = (SELECT scheduled_at FROM calls WHERE series_id = $1 ORDER BY scheduled_at OFFSET 5 LIMIT 1),
			occurrence_count = 5 WHERE id = $1`, sid)
		f.exec(`DELETE FROM call_participants WHERE call_id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY scheduled_at) rn FROM calls WHERE series_id = $1) x WHERE rn > 5)`, sid)
		f.exec(`DELETE FROM calls WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY scheduled_at) rn FROM calls WHERE series_id = $1) x WHERE rn > 5)`, sid)
		for i := 0; i < 3; i++ {
			f.srv.sweepOverdueCalls(context.Background())
		}
		if n := f.count(`SELECT count(*) FROM calls WHERE series_id = $1`, sid); n != occurrences {
			t.Fatalf("the running sweeper left %d occurrences, want %d: top-up is not wired in", n, occurrences)
		}
		if after := len(f.events("call.scheduled")); after != before {
			t.Errorf("the sweeper's top-up sent %d notifications", after-before)
		}
	})

	patch := func(body map[string]any) int {
		c, raw := host("PATCH", "/api/v1/meeting-series/"+sid, body)
		if c != http.StatusOK {
			t.Fatalf("PATCH %v = %d %s", body, c, raw)
		}
		return len(f.events("call.scheduled"))
	}

	t.Run("an edit that changes nothing announces nothing", func(t *testing.T) {
		before := len(f.events("call.scheduled"))
		if after := patch(map[string]any{"title": "Weekly review", "inviteeIds": []string{f.ada}, "channelIds": []string{}}); after != before {
			t.Errorf("a no-op edit sent %d notifications", after-before)
		}
	})
	t.Run("adding one person announces to that person alone", func(t *testing.T) {
		before := len(f.events("call.scheduled"))
		after := patch(map[string]any{"inviteeIds": []string{f.ada, f.rival}})
		ev := f.events("call.scheduled")
		if after != before+1 || len(ev[after-1]) != 1 || ev[after-1][0] != f.rival {
			t.Errorf("events %d -> %d, last recipients %v; want one event to only %s", before, after, ev[after-1], f.rival)
		}
	})
	t.Run("a person in TWO added channels is told once", func(t *testing.T) {
		before := len(f.events("call.scheduled"))
		after := patch(map[string]any{"channelIds": []string{ch1, ch2}})
		last := f.events("call.scheduled")[after-1]
		if after != before+1 {
			t.Fatalf("events %d -> %d, want exactly one", before, after)
		}
		seen := map[string]int{}
		for _, u := range last {
			seen[u]++
		}
		if len(last) != 1 || seen[f.grace] != 1 {
			t.Errorf("recipients = %v, want grace exactly once and nobody else", last)
		}
	})
	t.Run("a title change tells everyone, once", func(t *testing.T) {
		before := len(f.events("call.scheduled"))
		after := patch(map[string]any{"title": "Renamed"})
		last := f.events("call.scheduled")[after-1]
		if after != before+1 || strings.Join(last, ",") != strings.Join(sorted(f.host, f.ada, f.rival, f.grace), ",") {
			t.Errorf("events %d -> %d, recipients %v", before, after, last)
		}
		// An edit is flagged so notification-svc reads it as "updated"; the creation
		// and the "you were added" announcements before it were not.
		const updatedEvents = `SELECT count(*) FROM outbox
			WHERE payload->>'type' = 'call.scheduled' AND payload->>'change' = 'updated' AND payload->>'orgId' = $1`
		if n := f.count(updatedEvents, f.org); n != 1 {
			t.Errorf("%d call.scheduled events flagged change=updated, want exactly the title edit's", n)
		}
	})
	t.Run("cancelling announces once, and cancelling again nothing", func(t *testing.T) {
		if c, raw := host("DELETE", "/api/v1/meeting-series/"+sid, nil); c != http.StatusNoContent {
			t.Fatalf("DELETE = %d %s", c, raw)
		}
		if n := len(f.events("call.ended")); n != 1 {
			t.Fatalf("%d call.ended events after a cancel, want 1", n)
		}
		// notification-svc turns this into "Meeting cancelled" only when it says CANCELLED
		// (an ordinary end says ENDED), so the status is part of the contract.
		if n := f.count(`SELECT count(*) FROM outbox WHERE payload->>'type' = 'call.ended'
			AND payload->>'status' = 'CANCELLED' AND payload->>'orgId' = $1`, f.org); n != 1 {
			t.Errorf("%d call.ended events carry status CANCELLED, want 1", n)
		}
		if c, _ := host("DELETE", "/api/v1/meeting-series/"+sid, nil); c != http.StatusNoContent {
			t.Errorf("cancelling twice = %d, want 204", c)
		}
		if n := len(f.events("call.ended")); n != 1 {
			t.Errorf("cancelling twice sent another notification (%d)", n)
		}
		if c, _ := host("PATCH", "/api/v1/meeting-series/"+sid, map[string]any{"title": "zombie"}); c != http.StatusConflict {
			t.Errorf("editing a cancelled series = %d, want 409", c)
		}
	})
}

// ── Existing behaviour ──────────────────────────────────────────────────────────

func TestSeriesHTTP_OneOffMeetingsAndMeetingLinksBehaveAsBefore(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	guest := f.as(f.stranger, f.other)

	// The request every existing client sends: no channels, no recurrence.
	code, raw := host("POST", "/api/v1/meetings", map[string]any{
		"title": "plain", "media": "video", "scheduledAt": time.Now().Add(3 * time.Hour).Format(time.RFC3339),
		"durationMinutes": 30, "inviteeIds": []string{f.ada},
	})
	if code != http.StatusCreated {
		t.Fatalf("create one-off = %d %s", code, raw)
	}
	one := decode[callResp](t, raw)
	if one.Series != nil || one.Status != "SCHEDULED" || len(one.Participants) != 2 {
		t.Errorf("one-off = %+v", one)
	}
	var generic map[string]any
	_ = json.Unmarshal(raw, &generic)
	if cid, ok := generic["channelIds"].([]any); !ok || len(cid) != 0 {
		t.Errorf("channelIds = %v; must be present, and an empty list", generic["channelIds"])
	}
	if _, has := generic["series"]; has {
		t.Error("a one-off carries a series key")
	}

	// A meeting addressed to a channel, joined by an outsider through a link.
	code, raw = host("POST", "/api/v1/meetings", map[string]any{
		"title": "channel meeting", "media": "video", "scheduledAt": time.Now().Add(4 * time.Hour).Format(time.RFC3339),
		"channelIds": []string{f.channel},
	})
	if code != http.StatusCreated {
		t.Fatalf("create channel meeting = %d %s", code, raw)
	}
	cm := decode[callResp](t, raw)
	if len(cm.ChannelIDs) != 1 || len(cm.Participants) != 3 {
		t.Errorf("channel meeting = %+v", cm)
	}
	code, raw = host("POST", "/api/v1/calls/"+cm.ID+"/invites", map[string]any{})
	if code != http.StatusCreated {
		t.Fatalf("mint link = %d %s", code, raw)
	}
	var inv map[string]any
	_ = json.Unmarshal(raw, &inv)
	token, _ := inv["token"].(string)
	if token == "" {
		t.Fatalf("no token in %s", raw)
	}
	code, raw = guest("POST", "/api/v1/calls/join", map[string]any{"token": token})
	if code != http.StatusOK {
		t.Fatalf("redeeming a meeting link = %d %s", code, raw)
	}
	if joined := decode[callResp](t, raw); len(joined.ChannelIDs) != 0 {
		t.Errorf("the host org's channel ids reached an outsider through the join response: %v", joined.ChannelIDs)
	}
	code, raw = guest("GET", "/api/v1/calls/"+cm.ID, nil)
	if code != http.StatusOK || len(decode[callResp](t, raw).ChannelIDs) != 0 {
		t.Errorf("the outsider's GET = %d, channelIds %v", code, decode[callResp](t, raw).ChannelIDs)
	}
	if code, raw = host("GET", "/api/v1/calls/"+cm.ID, nil); code != http.StatusOK || len(decode[callResp](t, raw).ChannelIDs) != 1 {
		t.Errorf("the host org's own GET lost the channel ids: %d %s", code, raw)
	}
}
