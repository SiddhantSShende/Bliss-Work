// Command bridge replicates platform events between regions over NATS
// JetStream.
//
// It replaces Kafka MirrorMaker2 for the cross-region hop. Kafka remains the
// in-region bus and no service changes: the bridge is one more consumer of the
// local log and one more producer into it, so turning it off leaves every
// region working exactly as it did before — which is the whole rollback story.
//
//	local Kafka ──(export)──► EVENTS_OUT_<region> ──JetStream──► peers
//	local Kafka ◄──(import)── EVENTS_IN_<region>  ◄──sources──── peers
//
// See docs/CROSS-REGION.md for the topology, the loop-freedom argument and the
// runbook.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/region-bridge/internal/bridge"
	"github.com/task-board/region-bridge/internal/config"
	"github.com/task-board/region-bridge/internal/health"
	"github.com/task-board/region-bridge/internal/metrics"
	"github.com/task-board/region-bridge/internal/streams"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel()}))
	slog.SetDefault(log)

	cfg, err := config.Load()
	if err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(1)
	}
	log.Info("region bridge starting",
		"region", cfg.Region, "peers", cfg.Peers, "topics", cfg.Topics,
		"export", cfg.ExportEnabled, "import", cfg.ImportEnabled)

	// Signals first, so a shutdown during a slow startup is honoured rather
	// than leaving a half-connected process to be killed.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	state := health.New(cfg.StallAfter)
	registry := prometheus.NewRegistry()
	metrics.Register(registry)
	// Reported even when a direction is off, so a dashboard shows a deliberate
	// rollback as "disabled" rather than as an outage.
	metrics.Up.WithLabelValues("export").Set(0)
	metrics.Up.WithLabelValues("import").Set(0)

	srv := serveHTTP(cfg, state, registry, log)

	nc, js, err := connectNATS(cfg, state, log)
	if err != nil {
		log.Error("cannot reach NATS", "url", cfg.NATSURL, "err", err)
		os.Exit(1)
	}
	defer nc.Drain() //nolint:errcheck // best-effort on the way out

	// Provisioning is idempotent and refuses to continue in a topology that
	// could loop, so every pod start re-asserts the invariant rather than
	// trusting whoever ran the last one.
	provisionCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	consumer, err := streams.Provision(provisionCtx, js, cfg)
	cancel()
	if err != nil {
		log.Error("cannot provision the cross-region topology", "err", err)
		os.Exit(1)
	}

	writer := kafkaWriter(cfg)
	dlq := dlqWriter(cfg)
	// Optimistic until proven otherwise. Both halves correct this from their
	// own I/O — a fetch or a write is a cheaper and more honest liveness signal
	// for the local cluster than a probe that only this process would run.
	state.SetKafka(true)
	defer closeWriters(log, writer, dlq)

	var wg sync.WaitGroup
	if cfg.ExportEnabled {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bridge.NewExporter(cfg, js, dlq, state, log).Run(ctx)
		}()
	} else {
		log.Warn("export is DISABLED: events produced here will not reach other regions")
	}
	if cfg.ImportEnabled {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bridge.NewImporter(cfg, consumer, writer, dlq, state, log).Run(ctx)
		}()
	} else {
		log.Warn("import is DISABLED: events from other regions will queue in JetStream")
	}

	<-ctx.Done()
	log.Info("shutting down")
	// Stop taking traffic first, then let the workers finish the batch they are
	// holding. Both halves settle their own work — nothing is acknowledged
	// before it has landed — so the worst case of a hard kill here is a replay,
	// not a loss.
	shutdownCtx, done := context.WithTimeout(context.Background(), 20*time.Second)
	defer done()
	_ = srv.Shutdown(shutdownCtx)

	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
		log.Info("stopped cleanly")
	case <-shutdownCtx.Done():
		// Deliberately bounded: an orchestrator that asked us to stop will kill
		// the process shortly, and hanging here only makes the rollout slower.
		log.Warn("workers did not stop in time; exiting anyway")
	}
}

// connectNATS dials with reconnection enabled and wires the connection state
// into the health surface.
//
// MaxReconnects is unlimited on purpose: a cross-region link fails for minutes
// at a time and a bridge that gave up would need a restart to come back, which
// is exactly the manual step nobody is awake for.
func connectNATS(cfg *config.Config, state *health.State, log *slog.Logger) (*nats.Conn, jetstream.JetStream, error) {
	opts := []nats.Option{
		nats.Name("region-bridge-" + cfg.Region),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2 * time.Second),
		nats.ReconnectJitter(500*time.Millisecond, 2*time.Second),
		// The health surface is driven by these rather than polled, so /readyz
		// reflects a dropped link within the callback rather than within a
		// scrape interval.
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			state.SetNATS(false)
			log.Warn("nats disconnected", "err", err)
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			state.SetNATS(true)
			log.Info("nats reconnected", "url", nc.ConnectedUrl())
		}),
		nats.ClosedHandler(func(*nats.Conn) { state.SetNATS(false) }),
	}
	if cfg.NATSCredentials != "" {
		opts = append(opts, nats.UserCredentials(cfg.NATSCredentials))
	}
	nc, err := nats.Connect(cfg.NATSURL, opts...)
	if err != nil {
		return nil, nil, err
	}
	state.SetNATS(true)

	// The async window is the export side's back-pressure. Bounded so a stalled
	// server becomes slowness — PublishMsgAsync starts returning a retryable
	// error — instead of an unbounded queue of in-flight messages and an
	// out-of-memory kill.
	js, err := jetstream.New(nc, jetstream.WithPublishAsyncMaxPending(cfg.PublishWindow))
	if err != nil {
		nc.Close()
		return nil, nil, err
	}
	return nc, js, nil
}

// kafkaWriter produces imported events into the local cluster.
func kafkaWriter(cfg *config.Config) *kafka.Writer {
	return &kafka.Writer{
		Addr:     kafka.TCP(cfg.KafkaBrokers...),
		Balancer: &kafka.Hash{}, // key-based, so partitioning matches the origin region's
		// acks=all. A replicated event that is acknowledged and then lost is
		// worse than one that is retried: the origin region has already moved
		// on and nothing will re-send it.
		RequiredAcks: kafka.RequireAll,
		// Never create a topic by writing to it. A typo in a peer's header
		// would otherwise conjure a topic nobody configured, and it would sit
		// there collecting events no consumer reads.
		AllowAutoTopicCreation: false,
		BatchTimeout:           10 * time.Millisecond,
		BatchBytes:             1 << 20,
	}
}

func dlqWriter(cfg *config.Config) *kafka.Writer {
	if cfg.DLQTopic == "" {
		return nil
	}
	return &kafka.Writer{
		Addr:                   kafka.TCP(cfg.KafkaBrokers...),
		Topic:                  cfg.DLQTopic,
		Balancer:               &kafka.Hash{},
		RequiredAcks:           kafka.RequireAll,
		AllowAutoTopicCreation: false,
	}
}

func closeWriters(log *slog.Logger, ws ...*kafka.Writer) {
	for _, w := range ws {
		if w == nil {
			continue
		}
		if err := w.Close(); err != nil {
			log.Warn("closing kafka writer", "err", err)
		}
	}
}

func serveHTTP(cfg *config.Config, state *health.State, reg *prometheus.Registry, log *slog.Logger) *http.Server {
	mux := http.NewServeMux()
	state.Handler(mux, promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Fatal: without this listener the orchestrator has no probe and no
			// metrics, so it would keep a blind replica in rotation.
			log.Error("health listener failed", "addr", cfg.HTTPAddr, "err", err)
			os.Exit(1)
		}
	}()
	return srv
}

func logLevel() slog.Level {
	if os.Getenv("LOG_LEVEL") == "debug" {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}
