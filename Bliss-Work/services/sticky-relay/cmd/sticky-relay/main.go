// sticky-relay — the desktop-note delivery watchdog.
//
// A task note appears on someone's desktop because a `task.assigned` frame
// arrives over the websocket. If that frame is lost — a reconnect at the wrong
// moment, or the user offline past ws-gateway's 24h replay window — the note
// never appears, and today nothing notices. sticky-svc records whether a pin
// was ever confirmed delivered; this service turns "open, and nobody ever
// confirmed seeing it" into a nudge telling that user's clients to re-fetch.
//
// It holds no database and no state. Every decision is in internal/sweep,
// kept pure and covered by table tests (sweep_test.go); this file is the
// loop, the wiring and the shutdown.
//
// Runs as a SINGLE replica, unlike the request-serving services. There is no
// throughput reason for a second sweeper, and while the claim in sticky-svc
// makes concurrent sweeps safe, one is simply the right number.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	kafkaauth "github.com/task-board/shared-kafkaauth"
	"github.com/task-board/sticky-relay/internal/config"
	"github.com/task-board/sticky-relay/internal/emit"
	"github.com/task-board/sticky-relay/internal/pins"
	"github.com/task-board/sticky-relay/internal/sweep"
)

func main() {
	cfg, err := config.Load()

	level := slog.LevelInfo
	if err == nil {
		if lvlErr := level.UnmarshalText([]byte(cfg.LogLevel)); lvlErr != nil {
			level = slog.LevelInfo
		}
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	if err != nil {
		log.Error("config error", "error", err)
		os.Exit(1)
	}

	// Kafka connection security, resolved once and checked BEFORE any client is
	// built — same gate the other Kafka-producing services apply before their
	// own Kafka clients. A protocol that names SASL with no credentials must
	// fail loudly here, not silently degrade to an unauthenticated transport.
	if err := kafkaauth.Validate(); err != nil {
		log.Error("kafka security config invalid", "error", err)
		os.Exit(1)
	}

	client := pins.New(cfg.StickyBase, cfg.InternalToken)
	producer := emit.New(cfg.KafkaBrokers, cfg.DryRun)
	defer producer.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go serveHealth(ctx, cfg.MetricsPort, log)

	log.Info("sticky_relay_started",
		"sweep_interval", cfg.SweepInterval.String(),
		"stale_after", cfg.StaleAfter.String(),
		"batch_limit", cfg.BatchLimit,
		"dry_run", cfg.DryRun,
	)

	ticker := time.NewTicker(cfg.SweepInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("sticky_relay_stopped")
			return
		case <-ticker.C:
			runSweep(ctx, cfg, client, producer, log)
		}
	}
}

// runSweep performs one pass. Every failure is logged and swallowed: a sweep
// that cannot reach sticky-svc or Kafka must not take the process down, because
// the next tick is a minute away and the condition is usually transient.
func runSweep(
	ctx context.Context,
	cfg *config.Config,
	client *pins.Client,
	producer *emit.Producer,
	log *slog.Logger,
) {
	// Bounded independently of the ticker so a hung dependency cannot stall the
	// loop past its next tick.
	sweepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	undelivered, err := client.Undelivered(sweepCtx, cfg.StaleAfter, cfg.BatchLimit)
	if err != nil {
		log.Warn("sweep_fetch_failed", "error", err)
		return
	}
	if len(undelivered) == 0 {
		return
	}

	now := time.Now()
	refreshes := sweep.Plan(undelivered)
	if len(refreshes) == 0 {
		// Every pin claimed this pass was inside its backoff or past the cap.
		// Worth saying, because it is the difference between "nothing to do"
		// and "we are giving up on these".
		log.Info("sweep_no_nudges_due", "claimed", len(undelivered))
		return
	}

	if err := producer.Publish(sweepCtx, refreshes, now); err != nil {
		log.Warn("sweep_publish_failed", "error", err, "refreshes", len(refreshes))
		return
	}

	log.Info("sweep_published",
		"refreshes", len(refreshes),
		"pins_claimed", len(undelivered),
		"dry_run", producer.DryRun(),
	)
}

// serveHealth exposes /healthz so the orchestrator can tell the process apart
// from a hung one. There is nothing to be "ready" for — this service serves no
// traffic — so liveness is the whole of it.
func serveHealth(ctx context.Context, port string, log *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Warn("health_server_stopped", "error", err)
	}
}
