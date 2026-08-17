package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/task-board/notification-svc/internal/auth"
	"github.com/task-board/notification-svc/internal/config"
	"github.com/task-board/notification-svc/internal/consumer"
	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/httpapi"
	"github.com/task-board/notification-svc/internal/kafkaauth"
	"github.com/task-board/notification-svc/internal/outbox"
	"github.com/task-board/notification-svc/internal/tracing"
)

const serviceName = "notification-svc"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "error", err)
		os.Exit(1)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Optional distributed tracing. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
	shutdownTracing := tracing.Init(rootCtx, serviceName, logger)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownTracing(ctx); err != nil {
			logger.Error("tracing shutdown error", "error", err)
		}
	}()

	// Connect DB (retry briefly to tolerate startup ordering).
	pool := connectWithRetry(rootCtx, cfg.DatabaseURL, logger)
	defer pool.Close()

	if err := db.Migrate(rootCtx, pool); err != nil {
		logger.Error("migrations failed", "error", err)
		os.Exit(1)
	}
	logger.Info("migrations applied")

	verifier, err := auth.NewVerifier(rootCtx, cfg.JWKSURL, cfg.JWTIssuer)
	if err != nil {
		logger.Error("jwks verifier init failed", "error", err)
		os.Exit(1)
	}

	// Kafka connection security, resolved once and checked BEFORE any client is
	// built. A protocol that names SASL with no credentials is a deployment
	// mistake, and the failure it would otherwise produce — a consumer that
	// never connects — reads as a broker outage rather than a config error.
	if err := kafkaauth.Validate(); err != nil {
		logger.Error("kafka security config invalid", "err", err)
		os.Exit(1)
	}
	logger.Info("kafka security", "protocol", kafkaauth.Protocol())

	// Background workers. Tracked via a WaitGroup so shutdown can wait for
	// in-flight work to drain before the process exits.
	var workers sync.WaitGroup

	pub := outbox.NewPublisher(pool, cfg.KafkaBrokers, logger)
	workers.Add(1)
	go func() {
		defer workers.Done()
		pub.Run(rootCtx)
	}()

	cons := consumer.New(pool, cfg.KafkaBrokers, logger)
	workers.Add(1)
	go func() {
		defer workers.Done()
		cons.Run(rootCtx)
	}()

	// HTTP server.
	srv := httpapi.New(pool, verifier, cfg.WebOrigin, logger)
	// Wrap the root handler so every request is a server span; otelhttp also
	// extracts incoming W3C tracecontext. No-op overhead when tracing is disabled.
	handler := otelhttp.NewHandler(srv.Router(), serviceName)
	httpServer := &http.Server{
		Addr:              "0.0.0.0:" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("notification-svc listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server failed", "error", err)
			stop()
		}
	}()

	<-rootCtx.Done()
	logger.Info("shutdown signal received")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http shutdown error", "error", err)
	}

	// Drain background workers: rootCtx is already cancelled, so each Run is
	// returning. Wait for them (bounded by shutdownCtx) so in-flight work
	// finishes before exit; if they overrun the deadline, proceed anyway.
	drained := make(chan struct{})
	go func() {
		workers.Wait()
		close(drained)
	}()
	select {
	case <-drained:
		logger.Info("background workers drained")
	case <-shutdownCtx.Done():
		logger.Warn("background workers drain timed out")
	}

	logger.Info("notification-svc stopped")
}

func connectWithRetry(ctx context.Context, url string, logger *slog.Logger) *pgxpool.Pool {
	deadline := time.Now().Add(60 * time.Second)
	for {
		p, err := db.Connect(ctx, url)
		if err == nil {
			return p
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			logger.Error("db connect failed (giving up)", "error", err)
			os.Exit(1)
		}
		logger.Warn("db connect failed, retrying", "error", err)
		select {
		case <-ctx.Done():
			os.Exit(1)
		case <-time.After(2 * time.Second):
		}
	}
}
