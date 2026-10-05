// translate-gw: the one place BlissWork talks to Google Cloud Translation.
// auth-svc keeps the catalogs, the cache, the locale list and placeholder
// protection; this process only turns "translate these strings" into a Cloud
// Translation call, authenticated by Application Default Credentials.
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

	"github.com/task-board/translate-gw/internal/gtranslate"
	"github.com/task-board/translate-gw/internal/httpapi"
)

func main() {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	token := os.Getenv("TRANSLATE_INTERNAL_TOKEN")
	if token == "" {
		// Fail closed, loudly: every /v1 request would be 401 anyway.
		logger.Warn("TRANSLATE_INTERNAL_TOKEN is empty: all /v1 requests will be rejected")
	}

	srv := &httpapi.Server{Translator: gtranslate.New(), InternalToken: token, Log: logger}
	httpServer := &http.Server{
		// Fixed in-container port; compose and the healthcheck target 8012.
		Addr:              ":8012",
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// A cold catalog batch is one Google call; auth-svc's own timeout is 8s.
		WriteTimeout: 30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		logger.Info("translate-gw listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server failed", "error_type", fmt.Sprintf("%T", err))
			os.Exit(1)
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
