package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/task-board/translate-gw/internal/gtranslate"
	"google.golang.org/api/googleapi"
)

const token = "internal-secret"

type stub struct {
	langs []gtranslate.Language
	err   error
	calls int
	last  struct {
		texts          []string
		source, target string
		html           bool
	}
}

func (s *stub) Languages(context.Context, string) ([]gtranslate.Language, error) {
	return s.langs, s.err
}

func (s *stub) Translate(_ context.Context, texts []string, source, target string, html bool) ([]string, error) {
	s.calls++
	s.last.texts, s.last.source, s.last.target, s.last.html = texts, source, target, html
	if s.err != nil {
		return nil, s.err
	}
	out := make([]string, len(texts))
	for i, t := range texts {
		out[i] = "[" + target + "] " + t
	}
	return out, nil
}

func newServer(tr gtranslate.Translator, internalToken string) (http.Handler, *bytes.Buffer) {
	logs := &bytes.Buffer{}
	s := &Server{Translator: tr, InternalToken: internalToken, Log: slog.New(slog.NewJSONHandler(logs, nil))}
	return s.Handler(), logs
}

func do(h http.Handler, method, path, body, tok string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if tok != "" {
		req.Header.Set("X-Internal-Token", tok)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthIsOpenButV1RequiresTheInternalToken(t *testing.T) {
	h, _ := newServer(&stub{}, token)
	if c := do(h, "GET", "/readyz", "", "").Code; c != 200 {
		t.Errorf("readyz = %d", c)
	}
	for _, tok := range []string{"", "wrong"} {
		if c := do(h, "GET", "/v1/languages", "", tok).Code; c != 401 {
			t.Errorf("languages with token %q = %d, want 401", tok, c)
		}
		if c := do(h, "POST", "/v1/translate", `{}`, tok).Code; c != 401 {
			t.Errorf("translate with token %q = %d, want 401", tok, c)
		}
	}
}

func TestFailsClosedWhenNoTokenIsConfigured(t *testing.T) {
	h, _ := newServer(&stub{}, "")
	// An empty expected token must never mean "accept anything".
	if c := do(h, "GET", "/v1/languages", "", "").Code; c != 401 {
		t.Errorf("= %d, want 401", c)
	}
	if c := do(h, "GET", "/v1/languages", "", "anything").Code; c != 401 {
		t.Errorf("= %d, want 401", c)
	}
}

func TestTranslate_EnglishToSpanishAndHindi(t *testing.T) {
	st := &stub{}
	h, _ := newServer(st, token)
	for _, target := range []string{"es", "hi"} {
		body := fmt.Sprintf(`{"q":["Hello <span translate=\"no\">{{name}}</span>"],"source":"en","target":%q,"format":"html"}`, target)
		rec := do(h, "POST", "/v1/translate", body, token)
		if rec.Code != 200 {
			t.Fatalf("%s: status %d: %s", target, rec.Code, rec.Body)
		}
		var res struct{ Translations []string }
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		want := "[" + target + `] Hello <span translate="no">{{name}}</span>`
		if len(res.Translations) != 1 || res.Translations[0] != want {
			t.Errorf("%s: %v", target, res.Translations)
		}
		if st.last.source != "en" || st.last.target != target || !st.last.html {
			t.Errorf("forwarded %+v", st.last)
		}
	}
}

func TestTranslate_DefaultsSourceToEnglishAndValidatesInput(t *testing.T) {
	st := &stub{}
	h, _ := newServer(st, token)
	if c := do(h, "POST", "/v1/translate", `{"q":["a"],"target":"es","format":"text"}`, token).Code; c != 200 || st.last.source != "en" || st.last.html {
		t.Errorf("default source/format: code=%d %+v", c, st.last)
	}
	tooMany := `{"q":[` + strings.Repeat(`"x",`, 128) + `"x"],"target":"es","format":"text"}`
	for name, body := range map[string]string{
		"no target":   `{"q":["a"],"format":"text"}`,
		"no strings":  `{"q":[],"target":"es","format":"text"}`,
		"bad format":  `{"q":["a"],"target":"es","format":"markdown"}`,
		"not json":    `nope`,
		"129 strings": tooMany,
	} {
		before := st.calls
		if c := do(h, "POST", "/v1/translate", body, token).Code; c != 400 {
			t.Errorf("%s: %d, want 400", name, c)
		}
		if st.calls != before {
			t.Errorf("%s: reached Google", name)
		}
	}
}

func TestLanguages(t *testing.T) {
	h, _ := newServer(&stub{langs: []gtranslate.Language{{Code: "es", Name: "Spanish"}, {Code: "hi", Name: "Hindi"}}}, token)
	rec := do(h, "GET", "/v1/languages?target=en", "", token)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"code":"hi"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestErrorMapping_UnconfiguredIs503_GoogleIs502(t *testing.T) {
	h, _ := newServer(&stub{err: fmt.Errorf("%w: could not find default credentials", gtranslate.ErrNotConfigured)}, token)
	rec := do(h, "GET", "/v1/languages", "", token)
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "unconfigured") {
		t.Errorf("unconfigured: %d %s", rec.Code, rec.Body)
	}
	h, _ = newServer(&stub{err: &googleapi.Error{Code: 403, Message: "PERMISSION_DENIED"}}, token)
	rec = do(h, "POST", "/v1/translate", `{"q":["a"],"target":"es","format":"text"}`, token)
	if rec.Code != 502 || strings.Contains(rec.Body.String(), "PERMISSION_DENIED") {
		t.Errorf("google error: %d %s (must not echo Google's message)", rec.Code, rec.Body)
	}
}

// Whatever a failing call's error says — URLs with keys, bearer tokens, key
// material — it must not reach the logs or the response.
func TestNoCredentialOrTokenLeakageInLogsOrResponses(t *testing.T) {
	leaks := []string{"ya29.SECRET-ACCESS-TOKEN", "AIzaSECRETKEY", "-----BEGIN PRIVATE KEY-----", "Bearer SECRET"}
	for _, err := range []error{
		errors.New(`Get "https://translation.googleapis.com/x?key=AIzaSECRETKEY": Authorization: Bearer SECRET ya29.SECRET-ACCESS-TOKEN`),
		&googleapi.Error{Code: 401, Message: "bad -----BEGIN PRIVATE KEY----- ya29.SECRET-ACCESS-TOKEN", Body: "Bearer SECRET"},
		fmt.Errorf("%w: AIzaSECRETKEY ya29.SECRET-ACCESS-TOKEN", gtranslate.ErrNotConfigured),
	} {
		h, logs := newServer(&stub{err: err}, token)
		rec := do(h, "POST", "/v1/translate", `{"q":["a"],"target":"es","format":"text"}`, token)
		rec2 := do(h, "GET", "/v1/languages", "", token)
		all := logs.String() + rec.Body.String() + rec2.Body.String()
		for _, secret := range leaks {
			if strings.Contains(all, secret) {
				t.Errorf("%T leaked %q:\n%s", err, secret, all)
			}
		}
		if logs.Len() == 0 {
			t.Errorf("%T: expected a warning to be logged", err)
		}
	}
	// And the internal token itself is never logged on a rejected call.
	h, logs := newServer(&stub{}, token)
	do(h, "GET", "/v1/languages", "", "guess-"+token)
	if strings.Contains(logs.String(), token) {
		t.Error("internal token logged")
	}
}

func TestAccessLog_RecordsMethodPathStatusDuration_AndNothingSensitive(t *testing.T) {
	h, logs := newServer(&stub{}, token)
	do(h, "GET", "/readyz", "", "")
	do(h, "GET", "/v1/languages?target=en", "", "") // 401, still logged
	do(h, "POST", "/v1/translate", `{"q":["TOPSECRET-BODY-TEXT"],"target":"hi","format":"html"}`, token)

	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err == nil && m["msg"] == "request" {
			lines = append(lines, m)
		}
	}
	if len(lines) != 2 {
		t.Fatalf("want 2 request lines (health probe not logged), got %d:\n%s", len(lines), logs)
	}
	if lines[0]["method"] != "GET" || lines[0]["path"] != "/v1/languages" || lines[0]["status"] != float64(401) {
		t.Errorf("401 line: %v", lines[0])
	}
	if lines[1]["method"] != "POST" || lines[1]["path"] != "/v1/translate" || lines[1]["status"] != float64(200) {
		t.Errorf("translate line: %v", lines[1])
	}
	if _, ok := lines[1]["duration_ms"]; !ok {
		t.Error("no duration_ms")
	}
	for _, secret := range []string{token, "TOPSECRET-BODY-TEXT", "target=en", "X-Internal-Token"} {
		if strings.Contains(logs.String(), secret) {
			t.Errorf("access log leaked %q:\n%s", secret, logs)
		}
	}
}
