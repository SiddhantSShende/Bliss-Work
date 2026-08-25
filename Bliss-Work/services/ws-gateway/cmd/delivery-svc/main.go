// Command delivery-svc reads the fan-out topics once and pushes each event to
// the gateway nodes that actually hold its recipients.
//
// ── Why this is a second binary in the ws-gateway module ─────────────────────
// It is the same bounded context. It needs contract.RecipientsOf to decide who
// receives an event, the same Redis store for the replay outbox and the routing
// table, the same Kafka security config, the same metrics registry and the same
// tracing setup. A separate module would have to duplicate every one of those
// or export them across a package boundary that exists for no reason. Two
// binaries, one module, one domain.
//
// ── What it replaces ─────────────────────────────────────────────────────────
// The gateway's own Kafka consumer, which subscribes under a group id unique to
// each pod. That gives every pod the entire event stream, so Kafka egress and
// replay-outbox writes both scale with POD COUNT rather than with traffic —
// adding a gateway pod adds load to Kafka and Redis instead of relieving it.
//
// Here the stream is read once by a stable consumer group, each event's
// recipients are computed once, the outbox is written once, and each gateway
// receives only its own users.
//
// ── Running both at once is safe ─────────────────────────────────────────────
// Delivery is idempotent end to end: the outbox write is a ZADD of the same
// member, and clients dedupe on eventId. So this can run alongside the
// broadcast consumer while you watch the metrics converge, and the gateways can
// then be switched to WS_FANOUT_MODE=routed one at a time. Nothing needs a flag
// day.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/task-board/shared-kafkaauth"
	"github.com/task-board/ws-gateway/internal/config"
	"github.com/task-board/ws-gateway/internal/push"
	"github.com/task-board/ws-gateway/internal/router"
	"github.com/task-board/ws-gateway/internal/store"
	"github.com/task-board/ws-gateway/internal/tracing"
)

const serviceName = "delivery-svc"

func main() {
	cfg := config.Load()

	level := slog.LevelInfo
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)
	log.Info("delivery-svc starting", "group", router.ConsumerGroup)

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	traceShutdown, err := tracing.Init(rootCtx, serviceName, log)
	if err != nil {
		log.Warn("tracing init failed; continuing without tracing", "err", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := traceShutdown(ctx); err != nil {
			log.Warn("tracing shutdown failed", "err", err)
		}
	}()

	st, err := store.New(cfg.RedisURL)
	if err != nil {
		log.Error("redis init failed", "err", err)
		os.Exit(1)
	}
	defer func() { _ = st.Close() }()

	pingCtx, pc := context.WithTimeout(rootCtx, 5*time.Second)
	if err := st.Ping(pingCtx); err != nil {
		log.Warn("redis ping failed at startup", "err", err)
	}
	pc()

	if err := kafkaauth.Validate(); err != nil {
		log.Error("kafka security config invalid", "err", err)
		os.Exit(1)
	}
	log.Info("kafka security", "protocol", kafkaauth.Protocol())

	// The push credential is this service's entire authority over the gateways:
	// holding it means being able to deliver any payload to any connected user.
	// Refusing to start without one is better than running with the built-in
	// development default and having every push rejected as unauthorized.
	if cfg.WSGatewayInternalToken == "" {
		log.Error("WS_GATEWAY_INTERNAL_TOKEN is required — it authorizes every push to a gateway")
		os.Exit(1)
	}

	r := router.New(st, push.NewClient(cfg.WSGatewayInternalToken), log)
	consumer := router.NewConsumer(cfg.KafkaBrokers, r, log)
	go consumer.Run(rootCtx)

	// Metrics and health only. This service holds no sockets and serves no
	// users; the port exists so Prometheus can scrape it and so an orchestrator
	// has something to probe.
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		if err := st.Ping(ctx); err != nil {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	mux.Handle("/metrics", promhttp.Handler())

	srv := &http.Server{
		Addr:              "0.0.0.0:" + cfg.DeliveryPort,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("http listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-rootCtx.Done()
	log.Info("shutting down")
	shutdownCtx, sc := context.WithTimeout(context.Background(), 10*time.Second)
	defer sc()
	_ = srv.Shutdown(shutdownCtx)
}
