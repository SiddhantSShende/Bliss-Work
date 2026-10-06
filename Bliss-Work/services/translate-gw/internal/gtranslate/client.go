// Package gtranslate is the whole of translate-gw's contact with Google: the
// official Cloud Translation Basic (v2) Go client, authenticated with
// Application Default Credentials.
//
// ── Authentication ───────────────────────────────────────────────────────────
// Nothing here names a credential. Google's own ADC discovery
// (google.FindDefaultCredentials) runs in its documented order:
// GOOGLE_APPLICATION_CREDENTIALS (service-account, workload-identity-federation
// or impersonation config), then the gcloud well-known file
// (`gcloud auth application-default login`, development only), then the
// GCE/GKE/Cloud Run metadata server. No key is read, stored or logged by this
// code and no OAuth token ever passes through it; the library mints and
// refreshes its own.
//
// Discovery is explicit (not left to translate.NewClient) because NewClient
// silently falls back to a metadata-server token source when nothing is found:
// it "succeeds", then every request fails later with a transport error naming
// the metadata URL. Doing it here turns "no ADC" into one clear, fast
// ErrNotConfigured.
//
// The client is created lazily, on first use. A failed discovery is remembered
// only briefly (negativeTTL — the metadata probe is slow off-GCP), so the
// gateway starts and answers health checks without credentials, and picks them
// up shortly after an operator provisions them — no restart needed.
package gtranslate

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"cloud.google.com/go/translate"
	"golang.org/x/oauth2/google"
	"golang.org/x/text/language"
	"google.golang.org/api/option"
)

// scope is the narrowest OAuth scope that covers Cloud Translation. (Credential
// types whose scopes are fixed at issue time, like a gcloud user login, ignore it.)
const scope = "https://www.googleapis.com/auth/cloud-translation"

// negativeTTL is how long "no ADC" is remembered before discovery is retried.
const negativeTTL = 15 * time.Second

// ErrNotConfigured means ADC could not be found or used. The wrapped text is the
// library's own "could not find default credentials" style message, which names
// files and docs, never secret material.
var ErrNotConfigured = errors.New("google application default credentials are not available")

// Language is one language Cloud Translation can translate into.
type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// Translator is what the rest of the gateway needs from Google. An interface so
// every other package is tested without Google or the ADC machinery.
type Translator interface {
	// SupportedLanguages lists Google's languages with names in displayLanguage.
	SupportedLanguages(ctx context.Context, displayLanguage string) ([]Language, error)
	// TranslateHTML translates HTML-formatted inputs (so <span translate="no">
	// is honoured), returning one output per input, in order.
	TranslateHTML(ctx context.Context, texts []string, source, target string) ([]string, error)
}

// Google is the real Translator.
type Google struct {
	opts []option.ClientOption
	// discover returns the credential option for the client; ADC in production,
	// replaceable in tests.
	discover func(context.Context) (option.ClientOption, error)

	mu          sync.Mutex
	client      *translate.Client
	failedUntil time.Time
	failure     error
}

// New returns a Translator that discovers ADC itself. opts is for tests only
// (endpoint override); production passes none.
func New(opts ...option.ClientOption) *Google {
	return &Google{opts: opts, discover: discoverADC}
}

func discoverADC(ctx context.Context) (option.ClientOption, error) {
	creds, err := google.FindDefaultCredentials(ctx, scope)
	if err != nil {
		return nil, err
	}
	return option.WithCredentials(creds), nil
}

func (g *Google) get(ctx context.Context) (*translate.Client, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.client != nil {
		return g.client, nil
	}
	if time.Now().Before(g.failedUntil) {
		return nil, g.failure
	}
	cred, err := g.discover(ctx)
	if err != nil {
		g.failure = fmt.Errorf("%w: %v", ErrNotConfigured, err)
		g.failedUntil = time.Now().Add(negativeTTL)
		return nil, g.failure
	}
	// The client outlives the request that first needed it: do not tie it to ctx.
	c, err := translate.NewClient(context.WithoutCancel(ctx), append([]option.ClientOption{cred}, g.opts...)...)
	if err != nil {
		g.failure = fmt.Errorf("%w: %v", ErrNotConfigured, err)
		g.failedUntil = time.Now().Add(negativeTTL)
		return nil, g.failure
	}
	g.client = c
	return c, nil
}

func (g *Google) SupportedLanguages(ctx context.Context, displayLanguage string) ([]Language, error) {
	display, err := language.Parse(displayLanguage)
	if err != nil {
		return nil, fmt.Errorf("invalid display language %q", displayLanguage)
	}
	c, err := g.get(ctx)
	if err != nil {
		return nil, err
	}
	langs, err := c.SupportedLanguages(ctx, display)
	if err != nil {
		return nil, err
	}
	out := make([]Language, 0, len(langs))
	for _, l := range langs {
		out = append(out, Language{Code: l.Tag.String(), Name: l.Name})
	}
	return out, nil
}

func (g *Google) TranslateHTML(ctx context.Context, texts []string, source, target string) ([]string, error) {
	src, err := language.Parse(source)
	if err != nil {
		return nil, fmt.Errorf("invalid source language %q", source)
	}
	tgt, err := language.Parse(target)
	if err != nil {
		return nil, fmt.Errorf("invalid target language %q", target)
	}
	c, err := g.get(ctx)
	if err != nil {
		return nil, err
	}
	res, err := c.Translate(ctx, texts, tgt, &translate.Options{Source: src, Format: translate.HTML})
	if err != nil {
		return nil, err
	}
	out := make([]string, len(res))
	for i, r := range res {
		out[i] = r.Text
	}
	return out, nil
}
