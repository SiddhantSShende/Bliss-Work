package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/config"
	"github.com/task-board/ws-gateway/internal/delivery"
	"github.com/task-board/ws-gateway/internal/fanout"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/presence"
	"github.com/task-board/ws-gateway/internal/server"
	rtcsignal "github.com/task-board/ws-gateway/internal/signal"
	"github.com/task-board/ws-gateway/internal/store"
	"github.com/task-board/ws-gateway/internal/tracing"
)

func main() {
	cfg := config.Load()

	level := slog.LevelInfo
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	nodeID := uuid.NewString()
	log.Info("ws-gateway starting", "node", nodeID, "port", cfg.Port)

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Optional distributed tracing — only active when OTEL_EXPORTER_OTLP_ENDPOINT
	// is set; otherwise Init is a no-op and the service runs exactly as before.
	traceShutdown, err := tracing.Init(rootCtx, "ws-gateway", log)
	if err != nil {
		log.Warn("tracing init failed; continuing without tracing", "err", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := traceShutdown(shutdownCtx); err != nil {
			log.Warn("tracing shutdown failed", "err", err)
		}
	}()

	st, err := store.New(cfg.RedisURL)
	if err != nil {
		log.Error("redis init failed", "err", err)
		os.Exit(1)
	}
	defer func() { _ = st.Close() }()

	// Best-effort connectivity probe (do not block boot indefinitely).
	pingCtx, pc := context.WithTimeout(rootCtx, 5*time.Second)
	if err := st.Ping(pingCtx); err != nil {
		log.Warn("redis ping failed at startup", "err", err)
	}
	pc()

	verifier, err := auth.NewVerifier(rootCtx, cfg.JWKSURL, cfg.JWTIssuer)
	if err != nil {
		log.Error("jwks verifier init failed", "err", err)
		os.Exit(1)
	}

	h := hub.New()

	consumer := fanout.New(cfg.KafkaBrokers, nodeID, st, h, log)
	go consumer.Run(rootCtx)

	// Phase 5: delivery-ack dispatcher. Batches client message.ack frames
	// per recipient over 500ms windows and POSTs to messaging-svc, which
	// emits MessageDelivered through its outbox (gateway never produces).
	dispatcher := delivery.New(cfg.MessagingBaseInternal, cfg.InternalToken, log)
	go dispatcher.Run(rootCtx)

	// Phase 9: WebRTC signaling dispatcher (rtc.offer/answer/ice/cancel).
	// Local Hub.Fanout when peer is here; Redis pub/sub on rtc:user:* when
	// peer is on a different gateway node.
	signalDispatcher := rtcsignal.New(h, st, log)
	go signalDispatcher.RunSubscriber(rootCtx)

	// Live presence: broadcast online/offline transitions to org-mates over the
	// shared Redis presence channel; each node fans out to its local sockets.
	presenceBroadcaster := presence.New(h, st, log)
	go presenceBroadcaster.RunSubscriber(rootCtx)

	srv := server.New(server.Config{
		WebOrigin:       cfg.WebOrigin,
		MaxConnections:  cfg.MaxConnections,
		MaxConnsPerUser: cfg.MaxConnsPerUser,
	}, verifier, h, st, dispatcher, signalDispatcher, presenceBroadcaster, nodeID, log)

	// Wrap the root handler with otelhttp so every request becomes a server span
	// and incoming W3C tracecontext is extracted. The /ws route HIJACKS the
	// connection for the WebSocket upgrade; otelhttp's ResponseWriter wrapper can
	// interfere with hijacking, so /ws is routed to the raw handler unwrapped —
	// preserving the working WebSocket. When tracing is disabled (no provider
	// installed) otelhttp uses a no-op tracer, so this stays cheap either way.
	rootHandler := srv.Handler()
	tracedHandler := otelhttp.NewHandler(rootHandler, "ws-gateway")
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			rootHandler.ServeHTTP(w, r)
			return
		}
		tracedHandler.ServeHTTP(w, r)
	})

	httpServer := &http.Server{
		Addr:              "0.0.0.0:" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("http listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-rootCtx.Done()
	log.Info("shutting down", "open_conns", h.Count())

	// Drain active WebSockets first: close them cleanly so clients reconnect to
	// another node, rather than letting http.Shutdown block on long-lived sockets
	// for the full timeout and then drop them abruptly on process exit.
	h.CloseAll()

	shutdownCtx, sc := context.WithTimeout(context.Background(), 10*time.Second)
	defer sc()
	_ = httpServer.Shutdown(shutdownCtx)
}
