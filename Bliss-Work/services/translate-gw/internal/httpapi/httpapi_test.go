package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/task-board/translate-gw/internal/catalog"
	"github.com/task-board/translate-gw/internal/gtranslate"
	"github.com/task-board/translate-gw/internal/languages"
	"google.golang.org/api/googleapi"
)

const token = "s3cret-internal-token"

type fakeLanguages struct {
	langs []gtranslate.Language
	err   error
}

func (f fakeLanguages) List(context.Context) ([]gtranslate.Language, error) { return f.langs, f.err }
func (f fakeLanguages) Resolve(_ context.Context, locale string) (languages.Target, bool, error) {
	if f.err != nil {
		return languages.Target{}, false, f.err
	}
	for _, l := range f.langs {
		if strings.EqualFold(l.Code, locale) {
			g := l.Code
			if l.Code == "zh" {
				g = "zh-CN"
			}
			return languages.Target{Code: l.Code, GoogleCode: g}, true, nil
		}
	}
	return languages.Target{}, false, nil
}

type fakeCatalogs struct {
	res   *catalog.Result
	err   error
	built []string
}

func (f *fakeCatalogs) Build(_ context.Context, locale, googleTarget string) (*catalog.Result, error) {
	f.built = append(f.built, locale+">"+googleTarget)
	return f.res, f.err
}

func newServer(langs fakeLanguages, cats *fakeCatalogs) (*Server, *bytes.Buffer) {
	logs := &bytes.Buffer{}
	return &Server{
		Languages:     langs,
		Catalogs:      cats,
		English:       func() map[string]any { return map[string]any{"common": map[string]any{"ok": "OK"}} },
		InternalToken: token,
		Log:           slog.New(slog.NewJSONHandler(logs, nil)),
	}, logs
}

func do(h http.Handler, method, target, tok string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if tok != "" {
		req.Header.Set("X-Internal-Token", tok)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

var spanish = []gtranslate.Language{{Code: "es", Name: "Spanish"}, {Code: "fr", Name: "French"}}

func TestHealthNeedsNoToken(t *testing.T) {
	s, _ := newServer(fakeLanguages{}, &fakeCatalogs{})
	for _, p := range []string{"/healthz", "/readyz"} {
		if rec := do(s.Handler(), "GET", p, ""); rec.Code != 200 {
			t.Errorf("%s = %d", p, rec.Code)
		}
	}
}

func TestV1RequiresTheInternalToken_FailsClosed(t *testing.T) {
	s, _ := newServer(fakeLanguages{langs: spanish}, &fakeCatalogs{})
	for _, p := range []string{"/v1/languages", "/v1/catalog?locale=es"} {
		for _, tok := range []string{"", "wrong", token + "x"} {
			if rec := do(s.Handler(), "GET", p, tok); rec.Code != 401 {
				t.Errorf("%s with token %q = %d, want 401", p, tok, rec.Code)
			}
		}
	}
	// No token configured at all: even the "right" empty header must not get in.
	s.InternalToken = ""
	if rec := do(s.Handler(), "GET", "/v1/languages", ""); rec.Code != 401 {
		t.Errorf("unconfigured gateway answered %d", rec.Code)
	}
	if rec := do(s.Handler(), "GET", "/v1/languages", "anything"); rec.Code != 401 {
		t.Errorf("unconfigured gateway accepted a token: %d", rec.Code)
	}
}

func TestLanguages_ContractShape(t *testing.T) {
	s, _ := newServer(fakeLanguages{langs: spanish}, &fakeCatalogs{})
	rec := do(s.Handler(), "GET", "/v1/languages", token)
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
	var body struct {
		Languages []map[string]string `json:"languages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Languages) != 2 || body.Languages[0]["code"] != "es" || body.Languages[0]["name"] != "Spanish" || len(body.Languages[0]) != 2 {
		t.Fatalf("body = %s", rec.Body)
	}
}

func TestLanguages_EmptyIsAnEmptyArrayNotNull(t *testing.T) {
	s, _ := newServer(fakeLanguages{langs: []gtranslate.Language{}}, &fakeCatalogs{})
	if got := strings.TrimSpace(do(s.Handler(), "GET", "/v1/languages", token).Body.String()); got != `{"languages":[]}` {
		t.Fatalf("got %s", got)
	}
}

func TestCatalog_ContractShapeAndResolvedLocale(t *testing.T) {
	cats := &fakeCatalogs{res: &catalog.Result{Locale: "es", Namespaces: map[string]any{"common": map[string]any{"ok": "Vale"}}, Partial: true}}
	s, _ := newServer(fakeLanguages{langs: spanish}, cats)
	rec := do(s.Handler(), "GET", "/v1/catalog?locale=ES", token)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if want := `{"locale":"es","namespaces":{"common":{"ok":"Vale"}},"partial":true}`; strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("body = %s", rec.Body)
	}
	if len(cats.built) != 1 || cats.built[0] != "es>es" {
		t.Fatalf("built %v: must use the canonical code, not the raw query", cats.built)
	}
}

func TestCatalog_EnglishIsAnsweredWithoutGoogle(t *testing.T) {
	cats := &fakeCatalogs{}
	s, _ := newServer(fakeLanguages{err: gtranslate.ErrNotConfigured}, cats)
	rec := do(s.Handler(), "GET", "/v1/catalog?locale=en", token)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"partial":false`) || len(cats.built) != 0 {
		t.Fatalf("%d %s built=%v", rec.Code, rec.Body, cats.built)
	}
}

func TestCatalog_RejectsBadAndUnsupportedLocales(t *testing.T) {
	cats := &fakeCatalogs{}
	s, _ := newServer(fakeLanguages{langs: spanish}, cats)
	for _, q := range []string{"", "?locale=", "?locale=../x", "?locale=es%0Afr", "?locale=toolonglocale", "?locale=e"} {
		if rec := do(s.Handler(), "GET", "/v1/catalog"+q, token); rec.Code != 400 || !strings.Contains(rec.Body.String(), "bad_request") {
			t.Errorf("%q = %d %s", q, rec.Code, rec.Body)
		}
	}
	if rec := do(s.Handler(), "GET", "/v1/catalog?locale=de", token); rec.Code != 400 || !strings.Contains(rec.Body.String(), "unsupported_locale") {
		t.Errorf("unlisted locale = %d %s", rec.Code, rec.Body)
	}
	if len(cats.built) != 0 {
		t.Fatalf("an invalid locale reached the builder: %v", cats.built)
	}
}

func TestErrorsMapToStatusAndNeverLeakGoogleText(t *testing.T) {
	secret := "request to https://translation.googleapis.com/?key=SECRET failed"
	cases := []struct {
		name string
		err  error
		code int
		body string
	}{
		{"no ADC", gtranslate.ErrNotConfigured, 503, "unconfigured"},
		{"google 403", &googleapi.Error{Code: 403, Message: secret}, 502, "upstream"},
		{"transport", errors.New(secret), 502, "upstream"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, logs := newServer(fakeLanguages{langs: spanish}, &fakeCatalogs{err: c.err})
			for _, p := range []string{"/v1/catalog?locale=es"} {
				rec := do(s.Handler(), "GET", p, token)
				if rec.Code != c.code || !strings.Contains(rec.Body.String(), c.body) {
					t.Fatalf("%s = %d %s", p, rec.Code, rec.Body)
				}
				if strings.Contains(rec.Body.String(), "SECRET") || strings.Contains(logs.String(), "SECRET") {
					t.Fatalf("Google error text leaked: body=%s logs=%s", rec.Body, logs)
				}
			}
			s2, _ := newServer(fakeLanguages{err: c.err}, &fakeCatalogs{})
			if rec := do(s2.Handler(), "GET", "/v1/languages", token); rec.Code != c.code {
				t.Fatalf("languages = %d", rec.Code)
			}
		})
	}
}

func TestThereIsNoEndpointThatTranslatesArbitraryText(t *testing.T) {
	s, _ := newServer(fakeLanguages{langs: spanish}, &fakeCatalogs{})
	for _, m := range []string{"POST", "PUT", "GET"} {
		rec := do(s.Handler(), m, "/v1/translate", token)
		if rec.Code != 404 && rec.Code != 405 {
			t.Errorf("%s /v1/translate = %d", m, rec.Code)
		}
	}
}

func TestAccessLogHasNoTokenQueryOrBody(t *testing.T) {
	s, logs := newServer(fakeLanguages{langs: spanish}, &fakeCatalogs{res: &catalog.Result{Locale: "es"}})
	_ = do(s.Handler(), "GET", "/v1/catalog?locale=es", token)
	_ = do(s.Handler(), "GET", "/readyz", "")
	out := logs.String()
	if strings.Contains(out, token) || strings.Contains(out, "locale=es") || strings.Contains(out, "readyz") {
		t.Fatalf("log leaks or is noisy: %s", out)
	}
	if !strings.Contains(out, `"path":"/v1/catalog"`) || !strings.Contains(out, `"status":200`) {
		t.Fatalf("no access line: %s", out)
	}
	_ = io.Discard
}
