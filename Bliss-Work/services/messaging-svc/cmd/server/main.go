// Command server is the messaging-svc entrypoint.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/task-board/messaging-svc/internal/api"
	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/kafka"
	"github.com/task-board/messaging-svc/internal/media"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/internal/tracing"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	cfg, err := config.Load()
	if err != nil {
		log.Error("config load failed", "err", err)
		os.Exit(1)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Distributed tracing. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set; the
	// exporter is non-blocking so an unreachable collector never blocks startup.
	shutdownTracing, err := tracing.Init(rootCtx, "messaging-svc", log)
	if err != nil {
		log.Error("tracing init failed", "err", err)
		os.Exit(1)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTracing(ctx)
	}()

	// At-rest column encryption. Built once; fails closed on misconfig (e.g.
	// DATA_KEK_PROVIDER=kms without DATA_KMS_KEY_ID).
	cryptor, err := crypto.Build(crypto.Settings{
		KEKProvider:       cfg.Data.KEKProvider,
		MasterPassphrase:  cfg.Data.MasterPassphrase,
		MasterSalt:        cfg.Data.MasterSalt,
		KEKVersion:        cfg.Data.KEKVersion,
		DEKCacheTTLSecond: cfg.Data.DEKCacheTTLSecond,
		KMSBackend:        cfg.Data.KMSBackend,
		KMSKeyID:          cfg.Data.KMSKeyID,
		VaultAddr:         cfg.Data.VaultAddr,
		VaultToken:        cfg.Data.VaultToken,
	})
	if err != nil {
		log.Error("cryptor init failed", "err", err)
		os.Exit(1)
	}

	// DB connect (retry briefly while postgres warms up).
	var st *store.Store
	for i := 0; i < 30; i++ {
		st, err = store.New(rootCtx, cfg.DatabaseURL, cryptor)
		if err == nil {
			break
		}
		log.Warn("db not ready, retrying", "attempt", i+1, "err", err)
		select {
		case <-rootCtx.Done():
			os.Exit(1)
		case <-time.After(2 * time.Second):
		}
	}
	if err != nil {
		log.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	if err := st.Migrate(rootCtx); err != nil {
		log.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	log.Info("migrations applied")

	verifier, err := auth.NewVerifier(rootCtx, cfg.JWKSURL, cfg.JWTIssuer)
	if err != nil {
		log.Error("jwks verifier init failed", "err", err)
		os.Exit(1)
	}

	// Attachment storage. New() creates the directory tree and proves the volume
	// is writable now, so a misconfigured or read-only mount fails at boot
	// rather than on a user's first upload.
	blobs, err := blob.New(cfg.Media.Root)
	if err != nil {
		log.Error("media blob store init failed", "err", err, "root", cfg.Media.Root)
		os.Exit(1)
	}

	// Signer for attachment download URLs. config.Load already rejects a short
	// or missing MEDIA_URL_SECRET; this is the second, local assertion.
	signer, err := media.NewSigner(cfg.Media.URLSecret)
	if err != nil {
		log.Error("media url signer init failed", "err", err)
		os.Exit(1)
	}
	if cfg.Maps.APIKey == "" {
		log.Info("static map thumbnails disabled (MAPS_STATIC_API_KEY unset); " +
			"shared locations will render as a coordinates card")
	}

	// Background workers.
	poller := kafka.NewOutboxPoller(st, cfg.KafkaBrokers, log)
	go poller.Run(rootCtx)

	consumer := kafka.NewAuthConsumer(st, cfg.KafkaBrokers, log)
	go consumer.Run(rootCtx)

	// Phase 2: project task.events.v1 into inbox_items so the unified inbox
	// is a single-DB read. Separate consumer group + separate dedup table.
	taskProjector := kafka.NewTaskProjectionConsumer(st, cfg.KafkaBrokers, log)
	go taskProjector.Run(rootCtx)

	// Wrap the root handler so every request is a server span and incoming W3C
	// tracecontext headers are extracted. When tracing is disabled the global
	// no-op provider makes this effectively free.
	handler := otelhttp.NewHandler(
		api.NewServer(st, verifier, log, blobs, signer, cfg.Media, cfg.Maps).Router(cfg.WebOrigin),
		"messaging-svc")

	srv := &http.Server{
		Addr:              "0.0.0.0:" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("messaging-svc listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-rootCtx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
