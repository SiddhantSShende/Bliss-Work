// translate-gw: the one place BlissWork talks to Google Cloud Translation.
//
// It owns everything translation-related: the supported-language list, the
// English source catalogs, placeholder protection, the translation cache and the
// Cloud Translation calls themselves (authenticated by Application Default
// Credentials). auth-svc authenticates end users and forwards two read-only
// requests here with X-Internal-Token; it has no Google logic of its own.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/task-board/translate-gw/internal/cache"
	"github.com/task-board/translate-gw/internal/catalog"
	"github.com/task-board/translate-gw/internal/config"
	"github.com/task-board/translate-gw/internal/gtranslate"
	"github.com/task-board/translate-gw/internal/httpapi"
	"github.com/task-board/translate-gw/internal/languages"
)

func main() {
	if err := run(); err != nil {
		slog.Error("translate-gw failed to start", "error", err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	level := slog.LevelInfo
	if cfg.Debug {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	if cfg.InternalToken == "" {
		// Fail closed, loudly: every /v1 request would be 401 anyway.
		logger.Warn("TRANSLATE_INTERNAL_TOKEN is empty: all /v1 requests will be rejected")
	}
	source, err := catalog.LoadSource(cfg.SourceDir)
	if err != nil {
		return fmt.Errorf("loading English catalog: %w", err)
	}

	var store cache.Cache = cache.NewMemory()
	if cfg.RedisURL != "" {
		r, err := cache.NewRedis(cfg.RedisURL, logger)
		if err != nil {
			// Never print the URL: it carries the Redis password.
			return fmt.Errorf("REDIS_URL is not a valid redis URL (%T)", err)
		}
		store = r
	}

	translator := gtranslate.New()
	srv := &httpapi.Server{
		Languages: &languages.Service{Translator: translator, Configured: cfg.Locales, Log: logger},
		Catalogs:  &catalog.Builder{Source: source, Translator: translator, Cache: store, Log: logger},
		English:   source.English,

		InternalToken: cfg.InternalToken,
		Log:           logger,
	}
	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// A cold catalog is ~18 Google calls, a few at a time; the builder's own
		// ceiling is 2 minutes.
		WriteTimeout: 150 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		logger.Info("translate-gw listening", "addr", httpServer.Addr, "locales", cfg.Locales, "redis_cache", cfg.RedisURL != "")
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errc <- fmt.Errorf("server failed (%T)", err)
		}
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}
