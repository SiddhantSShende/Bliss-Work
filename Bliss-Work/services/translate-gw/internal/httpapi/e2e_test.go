package httpapi_test

// End to end through every real layer except Google's servers: HTTP handler →
// language discovery → catalog builder → the real Cloud Translation Go client,
// authenticated by Application Default Credentials found via
// GOOGLE_APPLICATION_CREDENTIALS, talking to a fake Google over HTTP.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/task-board/translate-gw/internal/cache"
	"github.com/task-board/translate-gw/internal/catalog"
	"github.com/task-board/translate-gw/internal/gtranslate"
	"github.com/task-board/translate-gw/internal/httpapi"
	"github.com/task-board/translate-gw/internal/languages"
	"google.golang.org/api/option"
)

func fakeGoogle(t *testing.T, translateCalls *atomic.Int32, badAuth *atomic.Int32) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "adc-test-token", "token_type": "Bearer", "expires_in": 3600})
	})
	check := func(r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer adc-test-token" || r.URL.Query().Get("key") != "" {
			badAuth.Add(1)
		}
	}
	mux.HandleFunc("/language/translate/v2/languages", func(w http.ResponseWriter, r *http.Request) {
		check(r)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"languages": []map[string]string{
			{"language": "en", "name": "English"}, {"language": "es", "name": "Spanish"}, {"language": "hi", "name": "Hindi"}, {"language": "af", "name": "Afrikaans"}, {"language": "zh-CN", "name": "Chinese (Simplified)"},
		}}})
	})
	mux.HandleFunc("/language/translate/v2", func(w http.ResponseWriter, r *http.Request) {
		check(r)
		translateCalls.Add(1)
		_ = r.ParseForm()
		var out []map[string]string
		for _, q := range r.Form["q"] {
			out = append(out, map[string]string{"translatedText": "[" + r.Form.Get("target") + "] " + q})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"translations": out}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func writeADCFile(t *testing.T, tokenURI string) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	body, _ := json.Marshal(map[string]string{
		"type": "service_account", "project_id": "test", "private_key_id": "k",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "t@test.iam.gserviceaccount.com", "client_id": "1", "token_uri": tokenURI,
	})
	path := filepath.Join(t.TempDir(), "adc.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEndToEnd_LanguagesAndCatalog_WithADC(t *testing.T) {
	t.Setenv("CLOUDSDK_CONFIG", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	var calls, badAuth atomic.Int32
	google := fakeGoogle(t, &calls, &badAuth)
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", writeADCFile(t, google.URL+"/token"))

	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "common.json"), []byte(`{"ok":"OK","hi":"Hi {{name}}"}`), 0o600)
	src, err := catalog.LoadSource(dir)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	tr := gtranslate.New(option.WithEndpoint(google.URL + "/language/translate/v2"))
	srv := &httpapi.Server{
		// "xx" is configured but unsupported by Google; "af" is Google's but unconfigured.
		Languages:     &languages.Service{Translator: tr, Configured: []string{"es", "xx", "hi", "zh"}, Log: log},
		Catalogs:      &catalog.Builder{Source: src, Translator: tr, Cache: cache.NewMemory(), Log: log},
		English:       src.English,
		InternalToken: "tok",
		Log:           log,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(path string) (int, string) {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		req.Header.Set("X-Internal-Token", "tok")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, strings.TrimSpace(string(b))
	}

	code, body := get("/v1/languages")
	if want := `{"languages":[{"code":"es","name":"Spanish"},{"code":"hi","name":"Hindi"},{"code":"zh","name":"Chinese (Simplified)"}]}`; code != 200 || body != want {
		t.Fatalf("languages = %d %s", code, body)
	}
	code, body = get("/v1/catalog?locale=hi")
	if want := `{"locale":"hi","namespaces":{"common":{"hi":"[hi] Hi {{name}}","ok":"[hi] OK"}},"partial":false}`; code != 200 || body != want {
		t.Fatalf("catalog = %d %s", code, body)
	}
	// Google lists "zh-CN"; BlissWork's public code stays "zh" while Google is asked for zh-CN.
	code, body = get("/v1/catalog?locale=zh")
	if want := `{"locale":"zh","namespaces":{"common":{"hi":"[zh-CN] Hi {{name}}","ok":"[zh-CN] OK"}},"partial":false}`; code != 200 || body != want {
		t.Fatalf("zh catalog = %d %s", code, body)
	}
	if code, _ = get("/v1/catalog?locale=af"); code != 400 {
		t.Fatalf("a Google-supported but unconfigured locale must be refused, got %d", code)
	}
	if calls.Load() != 2 {
		t.Fatalf("translate calls = %d, want 2 (one batch each for hi and zh)", calls.Load())
	}
	if badAuth.Load() != 0 {
		t.Fatalf("%d Google calls were not authenticated by the ADC bearer token", badAuth.Load())
	}
}

func TestEndToEnd_NoADC_Is503NotAFakeCatalog(t *testing.T) {
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("CLOUDSDK_CONFIG", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "common.json"), []byte(`{"ok":"OK"}`), 0o600)
	src, _ := catalog.LoadSource(dir)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	tr := gtranslate.New()
	srv := &httpapi.Server{
		Languages: &languages.Service{Translator: tr, Configured: []string{"es"}, Log: log},
		Catalogs:  &catalog.Builder{Source: src, Translator: tr, Cache: cache.NewMemory(), Log: log},
		English:   src.English, InternalToken: "tok", Log: log,
	}
	for _, p := range []string{"/v1/languages", "/v1/catalog?locale=es"} {
		req := httptest.NewRequest("GET", p, nil)
		req.Header.Set("X-Internal-Token", "tok")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != 503 || !strings.Contains(rec.Body.String(), "unconfigured") {
			t.Fatalf("%s = %d %s", p, rec.Code, rec.Body)
		}
	}
}
