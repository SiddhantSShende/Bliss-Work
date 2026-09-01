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

	"github.com/task-board/shared-kafkaauth"
	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/blocklist"
	"github.com/task-board/ws-gateway/internal/config"
	"github.com/task-board/ws-gateway/internal/delivery"
	"github.com/task-board/ws-gateway/internal/fanout"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/presence"
	"github.com/task-board/ws-gateway/internal/push"
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

	// No startup presence purge.
	//
	// There used to be one here, deleting every `presence:*` key, because
	// presence entries were removed only by a deferred call on the socket's
	// goroutine and a crashed node therefore left its users online forever.
	// That sweep was global, so it only worked while there was exactly one
	// gateway — a second replica booting would have logged out everyone
	// connected to the first, which is why the gateway could not be scaled.
	//
	// Presence now ages out on its own (see internal/store: heartbeat-scored
	// ZSETs, reaped on read), so there is nothing stale to clear and nothing
	// global to clear it with.

	verifier, err := auth.NewVerifier(rootCtx, cfg.JWKSURL, cfg.JWTIssuer)
	if err != nil {
		log.Error("jwks verifier init failed", "err", err)
		os.Exit(1)
	}

	h := hub.New()

	// ── Addressability ───────────────────────────────────────────────────────
	//
	// Registered REGARDLESS of the fan-out mode below, and that is the point:
	// the registry is how any other process reaches this pod's sockets, and RTC
	// signalling and presence now depend on it whether or not event fan-out is
	// routed. Gating it on WS_FANOUT_MODE would leave a broadcast-mode fleet
	// unable to route a call between two users on different pods.
	//
	// Without an advertise address a node is reachable by nothing. That is
	// harmless on a single gateway — every socket is local, so nothing ever has
	// to cross — and silently breaks cross-node calls on a fleet. So it warns
	// rather than failing: refusing to start would take down the single-node
	// case, which is the common one and is correct as it stands.
	// The TRANSPORT, not the raw client: Fanout addresses nodes by node id and
	// HTTPTransport is what turns one into a URL via the registry. Handing it the
	// bare *push.Client used to compile — the signatures matched — and then posted
	// every cross-node delivery to "<node-id>/internal/push", so RTC signalling and
	// presence never crossed a pod boundary. See push.Client.SendTo.
	pushTransport := push.NewHTTPTransport(push.NewClient(cfg.WSGatewayInternalToken), st)
	var nodeFanout *push.Fanout
	if cfg.AdvertiseAddr != "" {
		startNodeRegistration(rootCtx, st, nodeID, cfg.AdvertiseAddr, log)
		nodeFanout = push.NewFanout(st, h, pushTransport, nodeID, log)
		log.Info("node registered for cross-node delivery", "advertise", cfg.AdvertiseAddr)
	} else {
		log.Warn("WS_ADVERTISE_ADDR is not set — this node is not reachable by others. " +
			"Fine for a single gateway; on a fleet, RTC calls and presence between " +
			"users on different pods will not be delivered.")
	}

	// Kafka connection security, resolved once and checked BEFORE any client is
	// built. A protocol that names SASL with no credentials is a deployment
	// mistake, and the failure it would otherwise produce — a consumer that
	// never connects — reads as a broker outage rather than a config error.
	if err := kafkaauth.Validate(); err != nil {
		log.Error("kafka security config invalid", "err", err)
		os.Exit(1)
	}
	log.Info("kafka security", "protocol", kafkaauth.Protocol())

	// ── How events reach this node's sockets ─────────────────────────────────
	//
	// broadcast: this pod runs its own Kafka consumer under a group id unique
	//   to itself, so it receives EVERY event on every fan-out topic and
	//   discards the ones addressed to users it does not hold. Kafka egress and
	//   replay-outbox writes therefore scale with pod count rather than with
	//   traffic, which is what caps the fleet.
	//
	// routed: no consumer here at all. delivery-svc reads the stream once and
	//   pushes this pod only its own users' events (internal/push). The pod
	//   advertises where to reach it, and stops advertising when it stops.
	//
	// Both are safe to run at once across a fleet — delivery is idempotent and
	// clients dedupe on eventId — so gateways can be flipped one at a time.
	switch cfg.FanoutMode {
	case config.FanoutRouted:
		if cfg.AdvertiseAddr == "" {
			log.Error("WS_FANOUT_MODE=routed requires WS_ADVERTISE_ADDR — " +
				"delivery-svc has no other way to reach this pod")
			os.Exit(1)
		}
		// Registration already happened above, unconditionally — routed
		// delivery needs it, but so do RTC and presence in either mode.
		log.Info("fan-out mode: routed", "advertise", cfg.AdvertiseAddr)
	default:
		// The group id must be unique per node AND stable across restarts. It
		// used to be derived from nodeID, a UUID minted at process start, so
		// every restart joined as a group with no committed offset and began at
		// the tip — and because this mode is the only writer of the replay
		// outbox, everything published while the pod was down was never written
		// to anybody's catch-up buffer and no reconnect could recover it.
		//
		// An empty id would be worse than the bug: every pod would share one
		// group, Kafka would give each partition to exactly one of them, and a
		// pod would stop receiving events for users it is holding sockets for.
		// So this refuses rather than guessing.
		if cfg.BroadcastGroupID == "" {
			log.Error("broadcast fan-out needs a stable per-pod consumer group and " +
				"the hostname was unreadable — set WS_BROADCAST_GROUP_ID to something " +
				"unique per pod and stable across its restarts, or use WS_FANOUT_MODE=routed")
			os.Exit(1)
		}
		consumer := fanout.New(cfg.KafkaBrokers, cfg.BroadcastGroupID, st, h, log)
		go consumer.Run(rootCtx)
		log.Info("fan-out mode: broadcast (this pod consumes the entire event stream)",
			"group", cfg.BroadcastGroupID)
		if os.Getenv("WS_BROADCAST_GROUP_ID") == "" {
			// Hostname is stable for a container restart and for a pod's own
			// lifetime, which covers a crash loop. It is NOT stable across a
			// Deployment rollout, which mints new pod names — so the new pod
			// starts a new group at the tip and the deploy still skips whatever
			// was published between the old pod stopping and the new one
			// joining. Naming it here because it is invisible otherwise: no
			// error, no metric, just events that never arrive.
			log.Warn("broadcast group id derived from hostname; a Deployment rollout " +
				"changes it and the new pod will start at the tip, skipping events " +
				"published during the changeover. Set WS_BROADCAST_GROUP_ID from a " +
				"stable per-replica identity (a StatefulSet ordinal), or switch to " +
				"WS_FANOUT_MODE=routed, which reads under one shared group and has " +
				"no per-pod offset to lose.")
		}
	}

	// Phase 5: delivery-ack dispatcher. Batches client message.ack frames
	// per recipient over 500ms windows and POSTs to messaging-svc, which
	// emits MessageDelivered through its outbox (gateway never produces).
	dispatcher := delivery.New(cfg.MessagingBaseInternal, cfg.MessagingInternalToken, log)
	go dispatcher.Run(rootCtx)

	// Blocked-pair check for call.invite (P0-A). Same messaging-svc internal
	// endpoint config the delivery-ack dispatcher above already uses — no new
	// configuration surface, just a second small client against it.
	blockChecker := blocklist.NewClient(cfg.MessagingBaseInternal, cfg.MessagingInternalToken)

	// WebRTC signaling dispatcher (rtc.offer/answer/ice/cancel). Local
	// Hub.Fanout when the peer is here; a direct push to the node that holds
	// them when they are not. No subscriber: a signalling frame is addressed to
	// one user, so there is nothing to listen for on a shared channel.
	signalDispatcher := rtcsignal.New(h, st, blockChecker, nodeFanout, log)

	// Live presence: online/offline transitions to org-mates. Recipients are
	// resolved once here and pushed to the nodes holding them, rather than
	// broadcast to every node for each of them to work out separately.
	presenceBroadcaster := presence.New(h, st, nodeFanout, log)

	srv := server.New(server.Config{
		WebOrigin:              cfg.WebOrigin,
		MaxConnections:         cfg.MaxConnections,
		MaxConnsPerUser:        cfg.MaxConnsPerUser,
		WSGatewayInternalToken: cfg.WSGatewayInternalToken,
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

// startNodeRegistration advertises this pod as reachable and keeps doing so.
//
// The registration carries a TTL and is refreshed on a ticker, deliberately:
// this is the same reasoning presence uses. A pod that is SIGKILLed, OOM-killed
// or evicted runs no cleanup, so anything requiring an explicit deregistration
// is wrong the first time a node dies badly. An entry that ages out on its own
// needs no such step, and the deregistration on graceful shutdown below is
// purely an optimisation that shortens the window of pushes to a drained pod.
func startNodeRegistration(
	ctx context.Context, st *store.Store, nodeID, addr string, log *slog.Logger,
) {
	register := func() {
		regCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := st.RegisterNode(regCtx, nodeID, addr); err != nil {
			// Not fatal. The entry has a TTL and the next tick retries; the
			// cost of a miss is that delivery-svc cannot route to this pod for
			// a few seconds, and those events replay from the outbox.
			log.Warn("node registration failed", "node", nodeID, "err", err)
		}
	}
	// Register before returning so the pod is routable by the time it starts
	// accepting sockets, rather than up to one tick later.
	register()

	go func() { //nolint:gosec // G118: reported here (the goroutine statement), not on the context.Background() call below — see that line's comment for why it's deliberate
		ticker := time.NewTicker(store.NodeHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				// Best-effort: a fresh context, because ctx is already done. Deriving
				// from it (instead of context.Background()) would cancel this cleanup
				// immediately — that's the G118 finding above; it's a false positive.
				delCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				if err := st.DeregisterNode(delCtx, nodeID); err != nil {
					log.Warn("node deregistration failed", "node", nodeID, "err", err)
				}
				cancel()
				return
			case <-ticker.C:
				register()
			}
		}
	}()
}
