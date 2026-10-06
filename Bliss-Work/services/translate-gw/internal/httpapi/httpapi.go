// Package httpapi is translate-gw's internal HTTP surface. Its only caller is
// auth-svc, over the compose network, with X-Internal-Token. It is never routed
// by the edge proxy and publishes no host port; end users are authenticated by
// auth-svc, not here.
//
//	GET /v1/languages            -> {"languages":[{"code","name"}]}
//	GET /v1/catalog?locale=es    -> {"locale","namespaces":{ns:{…}},"partial":bool}
//	GET /healthz, /readyz        -> 200 (no credentials needed to be "ready")
//
// There is deliberately no endpoint that accepts text to translate: the only
// strings this service translates are the English UI catalog it loaded itself.
//
// Errors are a status code plus {"error": "<class>"}; never a Google message,
// which can echo request details:
//
//	400 bad_request / unsupported_locale, 401 unauthorized,
//	503 unconfigured (no ADC), 502 upstream (Google said no).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/task-board/shared-internalauth"
	"github.com/task-board/translate-gw/internal/catalog"
	"github.com/task-board/translate-gw/internal/config"
	"github.com/task-board/translate-gw/internal/gtranslate"
	"github.com/task-board/translate-gw/internal/languages"
	"google.golang.org/api/googleapi"
)

// LanguageLister is what the API needs from internal/languages.
type LanguageLister interface {
	List(ctx context.Context) ([]gtranslate.Language, error)
	Resolve(ctx context.Context, locale string) (languages.Target, bool, error)
}

// CatalogBuilder is what the API needs from internal/catalog.
type CatalogBuilder interface {
	Build(ctx context.Context, locale, googleTarget string) (*catalog.Result, error)
}

type Server struct {
	Languages     LanguageLister
	Catalogs      CatalogBuilder
	English       func() map[string]any
	InternalToken string
	Log           *slog.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	mux.HandleFunc("GET /healthz", ok)
	mux.HandleFunc("GET /readyz", ok)
	mux.HandleFunc("GET /v1/languages", s.internal(s.languages))
	mux.HandleFunc("GET /v1/catalog", s.internal(s.catalog))
	return s.accessLog(mux)
}

// statusRecorder remembers the status code a handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// accessLog logs one line per /v1 request: method, path, status, duration. That
// is all it logs, on purpose: no query string, no headers (X-Internal-Token).
// Health probes are not logged.
func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)
		s.Log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"duration_ms", time.Since(start).Milliseconds())
	})
}

// internal fails CLOSED: with no token configured, nobody gets in.
func (s *Server) internal(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !internalauth.Matches(r.Header.Get("X-Internal-Token"), s.InternalToken) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Server) languages(w http.ResponseWriter, r *http.Request) {
	langs, err := s.Languages.List(r.Context())
	if err != nil {
		s.fail(w, "languages", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"languages": langs})
}

func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	locale := r.URL.Query().Get("locale")
	if !config.LocaleShape.MatchString(locale) {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if strings.EqualFold(locale, config.SourceLanguage) {
		// Defensive: the client never asks for English (it is bundled), but
		// answering correctly costs nothing and spends no Google quota.
		writeJSON(w, http.StatusOK, map[string]any{"locale": config.SourceLanguage, "namespaces": s.English(), "partial": false})
		return
	}
	target, ok, err := s.Languages.Resolve(r.Context(), locale)
	if err != nil {
		s.fail(w, "catalog", err)
		return
	}
	if !ok {
		writeErr(w, http.StatusBadRequest, "unsupported_locale")
		return
	}
	res, err := s.Catalogs.Build(r.Context(), target.Code, target.GoogleCode)
	if err != nil {
		s.fail(w, "catalog", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"locale": res.Locale, "namespaces": res.Namespaces, "partial": res.Partial})
}

// fail maps an error to a status and logs ONLY its class (and Google's HTTP
// status when there is one), never err.Error(), which may contain request URLs
// or response bodies.
func (s *Server) fail(w http.ResponseWriter, op string, err error) {
	var gerr *googleapi.Error
	switch {
	case errors.Is(err, gtranslate.ErrNotConfigured):
		s.Log.Warn("translate_adc_unavailable", "op", op)
		writeErr(w, http.StatusServiceUnavailable, "unconfigured")
	case errors.As(err, &gerr):
		s.Log.Warn("translate_google_error", "op", op, "google_status", gerr.Code)
		writeErr(w, http.StatusBadGateway, "upstream")
	case errors.Is(err, context.Canceled):
		// Caller hung up; nothing to answer.
		writeErr(w, http.StatusServiceUnavailable, "canceled")
	default:
		s.Log.Warn("translate_failed", "op", op, "error_type", fmt.Sprintf("%T", err))
		writeErr(w, http.StatusBadGateway, "upstream")
	}
}

func writeErr(w http.ResponseWriter, code int, class string) {
	writeJSON(w, code, map[string]string{"error": class})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
