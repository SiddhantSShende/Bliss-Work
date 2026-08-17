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

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/task-board/messaging-svc/internal/api"
	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/kafka"
	"github.com/task-board/messaging-svc/internal/kafkaauth"
	"github.com/task-board/messaging-svc/internal/livekit"
	"github.com/task-board/messaging-svc/internal/media"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/readcache"
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

	// Optional read replica. Attached AFTER migrations, deliberately: a replica
	// is read-only, so it cannot run them, and connecting to one before the
	// primary's schema is current would let a lagging replica serve reads
	// against a schema that no longer matches the code.
	//
	// A configured-but-unreachable replica is a boot failure rather than a
	// degradation. The alternative — silently falling back to the primary —
	// hides the fact that the headroom you provisioned is not being used, and
	// the first sign would be a primary under load nobody expected.
	if err := st.WithReplica(rootCtx, cfg.DatabaseReplicaURL); err != nil {
		log.Error("read replica init failed", "err", err)
		os.Exit(1)
	}
	if st.HasReplica() {
		log.Info("read replica attached; lag-tolerant reads routed off the primary")
	}

	// The read cache. Same URL, same optionality, same argument for why a bad
	// URL is fatal and an unreachable Redis is not: a typo would otherwise leave
	// every read going to Postgres forever, which looks exactly like working,
	// only slower — and slower is the entire thing this exists to fix.
	//
	// Attached to the store BEFORE any request is served. Without it the store
	// misses on every lookup and behaves precisely as it did before caching
	// existed, so there is no behavioural branch to get wrong.
	cache, cerr := readcache.New(cfg.RedisURL)
	if cerr != nil {
		log.Error("read cache redis config invalid", "err", cerr)
		os.Exit(1)
	}
	if cache != nil {
		defer func() { _ = cache.Close() }()
		pingCtx, cancelPing := context.WithTimeout(rootCtx, 5*time.Second)
		if perr := cache.Ping(pingCtx); perr != nil {
			log.Warn("read cache redis unreachable at startup; "+
				"every read goes to Postgres until it recovers", "err", perr)
		} else {
			log.Info("read cache enabled (user_projection name lookups)")
		}
		cancelPing()
	} else {
		log.Warn("REDIS_URL is not set — no read cache. Every name lookup on the " +
			"message send path goes to the Postgres primary.")
	}
	st.WithReadCache(cache)

	// Fleet-wide rate limiting. Optional, and its absence is a real difference
	// worth saying out loud: without it each pod keeps its own buckets, so a
	// caller's actual allowance is the configured one multiplied by the replica
	// count.
	//
	// A bad URL fails the boot; an unreachable Redis only warns. The two are not
	// the same mistake. A malformed URL is a typo nobody meant, and it would
	// otherwise leave the limiter silently per-pod forever — which looks exactly
	// like working. Redis being down at this instant is an outage the service
	// should survive, and the limiter is built to degrade through it.

	rateStore, err := mw.NewSharedStore(cfg.RedisURL)
	if err != nil {
		log.Error("rate limit redis config invalid", "err", err)
		os.Exit(1)
	}
	if rateStore != nil {
		defer func() { _ = rateStore.Close() }()
		pingCtx, cancelPing := context.WithTimeout(rootCtx, 5*time.Second)
		if perr := rateStore.Ping(pingCtx); perr != nil {
			log.Warn("rate limit redis unreachable at startup; "+
				"limiting is per-pod until it recovers", "err", perr)
		} else {
			log.Info("rate limits are fleet-wide (one bucket per caller across all pods)")
		}
		cancelPing()
	} else {
		log.Warn("REDIS_URL is not set — rate limits are PER POD. With N replicas a " +
			"caller's real allowance is N times the configured one.")
	}

	verifier, err := auth.NewVerifier(rootCtx, cfg.JWKSURL, cfg.JWTIssuer)
	if err != nil {
		log.Error("jwks verifier init failed", "err", err)
		os.Exit(1)
	}

	// Attachment storage — local disk or an S3-compatible bucket, per
	// MEDIA_BACKEND. Either way Open() proves it can actually write before
	// returning (a directory probe, or a bucket check), so a read-only mount or
	// a mistyped endpoint fails at boot rather than on a user's first upload.
	blobs, err := blob.Open(rootCtx, blob.Options{
		Backend: cfg.Media.Backend,
		Root:    cfg.Media.Root,
		S3: blob.S3Config{
			Endpoint:  cfg.Media.S3.Endpoint,
			Bucket:    cfg.Media.S3.Bucket,
			AccessKey: cfg.Media.S3.AccessKey,
			SecretKey: cfg.Media.S3.SecretKey,
			Region:    cfg.Media.S3.Region,
			UseSSL:    cfg.Media.S3.UseSSL,
			Prefix:    cfg.Media.S3.Prefix,
		},
	})
	if err != nil {
		log.Error("media blob store init failed", "err", err, "backend", cfg.Media.Backend)
		os.Exit(1)
	}
	log.Info("media blob store ready", "backend", cfg.Media.Backend)

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

	// Kafka connection security, resolved once and checked BEFORE any client is
	// built. A protocol that names SASL with no credentials is a deployment
	// mistake, and the failure it would otherwise produce — a consumer that
	// never connects — reads as a broker outage rather than a config error.
	if err := kafkaauth.Validate(); err != nil {
		log.Error("kafka security config invalid", "err", err)
		os.Exit(1)
	}
	log.Info("kafka security", "protocol", kafkaauth.Protocol())

	// Background workers.
	poller := kafka.NewOutboxPoller(st, cfg.KafkaBrokers, log)
	go poller.Run(rootCtx)

	// Standing quarantine backlog, read at SCRAPE time rather than tracked in a
	// counter, so a process restart does not reset it to zero and report "all
	// clear" while rows are still stuck. The counter beside it
	// (messaging_outbox_dead_lettered_total) answers "did this ever happen";
	// this answers "is it happening now", and only the second survives a deploy.
	//
	// Bounded and read-only: a count over a partial index, on a timeout, and a
	// scrape failure degrades to a missing sample rather than a stuck handler.
	prometheus.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "messaging_outbox_dead_lettered",
			Help: "Outbox rows currently quarantined as unpublishable.",
		},
		func() float64 {
			ctx, cancel := context.WithTimeout(rootCtx, 2*time.Second)
			defer cancel()
			n, err := st.DeadLetterCount(ctx)
			if err != nil {
				return -1 // distinguishable from a genuine zero
			}
			return float64(n)
		},
	))

	consumer := kafka.NewAuthConsumer(st, blobs, cfg.KafkaBrokers, log)
	go consumer.Run(rootCtx)

	// Phase 2: project task.events.v1 into inbox_items so the unified inbox
	// is a single-DB read. Separate consumer group + separate dedup table.
	taskProjector := kafka.NewTaskProjectionConsumer(st, cfg.KafkaBrokers, log)
	go taskProjector.Run(rootCtx)

	// The SFU that carries group call media. Optional: with none configured,
	// lk reports itself unconfigured and call-token requests answer 503 rather
	// than failing somewhere deep in the client. A PARTIALLY configured one is
	// a boot error, because a half-set SFU is a deployment mistake that would
	// otherwise only surface when someone tried to start a meeting.
	lk, err := livekit.New(cfg.LiveKit.APIKey, cfg.LiveKit.APISecret, cfg.LiveKit.URL)
	if err != nil {
		log.Error("livekit config invalid", "err", err)
		os.Exit(1)
	}
	if lk.Configured() {
		log.Info("group calling enabled", "sfu", cfg.LiveKit.URL)
	} else {
		log.Warn("group calling disabled — LIVEKIT_* not set; 1:1 calls still work")
	}

	// Wrap the root handler so every request is a server span and incoming W3C
	// tracecontext headers are extracted. When tracing is disabled the global
	// no-op provider makes this effectively free.
	handler := otelhttp.NewHandler(
		api.NewServer(st, verifier, log, blobs, signer, cfg.Media, cfg.Maps, lk).
			WithSharedRateLimits(rateStore).
			Router(cfg.WebOrigin),
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
