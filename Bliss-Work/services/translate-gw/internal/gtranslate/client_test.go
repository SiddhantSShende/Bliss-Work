package gtranslate

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/api/option"
)

// fakeGoogle answers Cloud Translation Basic v2 over HTTP. It records the
// Authorization header of each API call so a test can prove ADC was applied.
type fakeGoogle struct {
	srv       *httptest.Server
	apiAuth   []string
	lastForm  url.Values
	tokenHits atomic.Int32
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	t.Helper()
	f := &fakeGoogle{}
	mux := http.NewServeMux()
	// OAuth2 token endpoint, which an ADC credential's token_uri points at.
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		f.tokenHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "adc-test-token", "token_type": "Bearer", "expires_in": 3600})
	})
	mux.HandleFunc("/language/translate/v2/languages", func(w http.ResponseWriter, r *http.Request) {
		f.apiAuth = append(f.apiAuth, r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"languages": []map[string]string{
			{"language": "es", "name": "Spanish"}, {"language": "hi", "name": "Hindi"},
		}}})
	})
	mux.HandleFunc("/language/translate/v2", func(w http.ResponseWriter, r *http.Request) {
		f.apiAuth = append(f.apiAuth, r.Header.Get("Authorization"))
		_ = r.ParseForm()
		f.lastForm = r.Form
		target := r.Form.Get("target")
		var out []map[string]string
		for _, q := range r.Form["q"] {
			out = append(out, map[string]string{"translatedText": "[" + target + "] " + q})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"translations": out}})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// unauthenticated is a Google client with ADC discovery bypassed, for tests that
// are about something other than authentication.
func unauthenticated(f *fakeGoogle) *Google {
	return &Google{
		opts:     []option.ClientOption{option.WithEndpoint(f.srv.URL + "/language/translate/v2")},
		discover: func(context.Context) (option.ClientOption, error) { return option.WithoutAuthentication(), nil },
	}
}

// withNoAmbientCredentials isolates the test from the developer's real ADC.
func withNoAmbientCredentials(t *testing.T) {
	t.Helper()
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("CLOUDSDK_CONFIG", t.TempDir()) // where the gcloud well-known file would be
	t.Setenv("HOME", t.TempDir())
}

func TestTranslate_EnglishToSpanishAndHindi_AuthenticatedByADC(t *testing.T) {
	withNoAmbientCredentials(t)
	f := newFakeGoogle(t)
	// A throwaway, test-generated credential file placed where ADC looks
	// (GOOGLE_APPLICATION_CREDENTIALS). Nothing is stored in the repo; the point
	// is that translate.NewClient is given NO credential option and still
	// authenticates, i.e. Google's library discovered ADC by itself.
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", writeFakeADCFile(t, f.srv.URL+"/token"))

	g := New(option.WithEndpoint(f.srv.URL + "/language/translate/v2"))

	for _, target := range []string{"es", "hi"} {
		got, err := g.Translate(context.Background(), []string{`Hello <span translate="no">{{name}}</span>`}, "en", target, true)
		if err != nil {
			t.Fatalf("translate to %s: %v", target, err)
		}
		if want := "[" + target + `] Hello <span translate="no">{{name}}</span>`; got[0] != want {
			t.Errorf("%s: got %q want %q", target, got[0], want)
		}
		if f.lastForm.Get("source") != "en" || f.lastForm.Get("format") != "html" {
			t.Errorf("source/format not forwarded: %v", f.lastForm)
		}
	}
	for i, a := range f.apiAuth {
		if a != "Bearer adc-test-token" {
			t.Errorf("api call %d Authorization = %q, want the ADC-minted bearer token", i, a)
		}
	}
	if f.tokenHits.Load() == 0 {
		t.Error("the ADC credential's token endpoint was never used")
	}
}

func TestLanguages_ReturnsCodesAndNames(t *testing.T) {
	withNoAmbientCredentials(t)
	f := newFakeGoogle(t)
	g := unauthenticated(f)
	langs, err := g.Languages(context.Background(), "en")
	if err != nil {
		t.Fatal(err)
	}
	if len(langs) != 2 || langs[0] != (Language{"es", "Spanish"}) || langs[1] != (Language{"hi", "Hindi"}) {
		t.Fatalf("languages = %+v", langs)
	}
}

func TestNoADC_IsNotConfigured_AndRecoversWhenCredentialsAppear(t *testing.T) {
	withNoAmbientCredentials(t)
	f := newFakeGoogle(t)
	g := New(option.WithEndpoint(f.srv.URL + "/language/translate/v2"))

	_, err := g.Translate(context.Background(), []string{"Hi"}, "en", "es", false)
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("want ErrNotConfigured with no ADC, got %v", err)
	}

	// The operator runs the login (here: the file appears). No restart: the
	// failure was not cached, so the very next call succeeds.
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", writeFakeADCFile(t, f.srv.URL+"/token"))
	if _, err := g.Translate(context.Background(), []string{"Hi"}, "en", "es", false); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("a failed discovery must be remembered briefly (it is slow off-GCP), got %v", err)
	}
	g.failedUntil = time.Time{} // the negative TTL elapsing
	got, err := g.Translate(context.Background(), []string{"Hi"}, "en", "es", false)
	if err != nil || got[0] != "[es] Hi" {
		t.Fatalf("after ADC appears: %v %v", got, err)
	}
}

func TestInvalidLanguageTagsAreRejectedBeforeAnyGoogleCall(t *testing.T) {
	withNoAmbientCredentials(t)
	f := newFakeGoogle(t)
	g := unauthenticated(f)
	if _, err := g.Translate(context.Background(), []string{"x"}, "en", "not a tag!!", false); err == nil {
		t.Fatal("expected an error for an invalid target")
	}
	if len(f.apiAuth) != 0 {
		t.Fatal("Google was called for an invalid target")
	}
}

// writeFakeADCFile writes a syntactically valid credential file of a freshly
// generated, throwaway key whose token_uri is the fake token endpoint. It is
// the cheapest hermetic way to exercise real ADC discovery.
func writeFakeADCFile(t *testing.T, tokenURI string) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	body, _ := json.Marshal(map[string]string{
		"type": "service_account", "project_id": "test", "private_key_id": "k",
		"private_key": pemKey, "client_email": "t@test.iam.gserviceaccount.com",
		"client_id": "1", "token_uri": tokenURI,
	})
	path := filepath.Join(t.TempDir(), "adc.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "adc-test-token") {
		t.Fatal("fixture must not contain a token")
	}
	return path
}
