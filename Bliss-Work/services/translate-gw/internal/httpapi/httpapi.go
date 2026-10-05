// Package httpapi is translate-gw's internal HTTP surface. Callers: auth-svc
// only, over the compose network, with X-Internal-Token. It is never routed by
// the edge proxy and publishes no host port.
//
//	GET  /v1/languages?target=en   -> {"languages":[{"code","name"}]}
//	POST /v1/translate             -> {"translations":["…"]}
//	     {"q":[…],"source":"en","target":"hi","format":"html"|"text"}
//	GET  /healthz, /readyz         -> 200 (no credentials needed to be "ready")
//
// Errors are a status code plus {"error": "<class>"}; never a Google message,
// which can echo request details. 503 = ADC not available, 502 = Google said no.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/task-board/shared-internalauth"
	"github.com/task-board/translate-gw/internal/gtranslate"
	"google.golang.org/api/googleapi"
)

const (
	maxBodyBytes = 1 << 20
	// Cloud Translation's documented per-request limit on `q`.
	maxStrings = 128
)

type Server struct {
	Translator    gtranslate.Translator
	InternalToken string
	Log           *slog.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	mux.HandleFunc("GET /healthz", ok)
	mux.HandleFunc("GET /readyz", ok)
	mux.HandleFunc("GET /v1/languages", s.internal(s.languages))
	mux.HandleFunc("POST /v1/translate", s.internal(s.translate))
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
// is all it logs, on purpose — no query string, no headers (X-Internal-Token),
// no bodies (the strings being translated). Its job is to make "did this call
// reach Google?" observable: every /v1/translate that was NOT served from
// auth-svc's cache appears here exactly once. Health probes are not logged.
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
	target := r.URL.Query().Get("target")
	if target == "" {
		target = "en"
	}
	langs, err := s.Translator.Languages(r.Context(), target)
	if err != nil {
		s.fail(w, r.Context(), "languages", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"languages": langs})
}

type translateRequest struct {
	Q      []string `json:"q"`
	Source string   `json:"source"`
	Target string   `json:"target"`
	Format string   `json:"format"`
}

func (s *Server) translate(w http.ResponseWriter, r *http.Request) {
	var req translateRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if req.Target == "" || len(req.Q) == 0 || len(req.Q) > maxStrings || (req.Format != "html" && req.Format != "text") {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if req.Source == "" {
		req.Source = "en"
	}
	out, err := s.Translator.Translate(r.Context(), req.Q, req.Source, req.Target, req.Format == "html")
	if err != nil {
		s.fail(w, r.Context(), "translate", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"translations": out})
}

// fail maps an error to a status and logs ONLY its class (and Google's HTTP
// status when there is one) — never err.Error(), which may contain request
// URLs or response bodies.
func (s *Server) fail(w http.ResponseWriter, _ context.Context, op string, err error) {
	var gerr *googleapi.Error
	switch {
	case errors.Is(err, gtranslate.ErrNotConfigured):
		s.Log.Warn("translate_adc_unavailable", "op", op)
		writeErr(w, http.StatusServiceUnavailable, "unconfigured")
	case errors.As(err, &gerr):
		s.Log.Warn("translate_google_error", "op", op, "google_status", gerr.Code)
		writeErr(w, http.StatusBadGateway, "upstream")
	default:
		s.Log.Warn("translate_failed", "op", op, "error_type", errType(err))
		writeErr(w, http.StatusBadGateway, "upstream")
	}
}

func errType(err error) string { return typeName(err) }

func writeErr(w http.ResponseWriter, code int, class string) {
	writeJSON(w, code, map[string]string{"error": class})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
