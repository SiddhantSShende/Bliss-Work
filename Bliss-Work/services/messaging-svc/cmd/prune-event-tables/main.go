// Command prune-event-tables applies retention to the event-plumbing tables.
//
//	prune-event-tables
//	prune-event-tables --dry-run
//
// WHY THIS EXISTS
// ---------------
// Nothing in the platform ever deleted a row from the tables that make the
// event pipeline work. A repo-wide search for `DELETE FROM outbox` returned
// nothing at all, in any of the seven services that have one.
//
// That is roughly four permanent rows per event, on the single Postgres
// primary, forever:
//
//	outbox                       one row per event ever produced, WITH ITS
//	                             FULL JSON PAYLOAD
//	consumed_events              one row per event ever consumed (auth stream)
//	consumed_events_inbox_tasks  one row per event ever consumed (task stream)
//	idempotency_keys             one row per idempotent write ever made
//
// `idempotency_keys` is the clearest evidence it was an oversight rather than a
// decision: 0003_threads_inbox.sql creates `idx_idempotency_keys_created`, an
// index on `created_at` whose only conceivable use is a sweeper by age, and no
// sweeper was ever written.
//
// The failure is slow and then sudden, and it is not primarily about disk. The
// hot paths stay index probes throughout; what degrades is everything around
// them — indexes outgrowing memory, autovacuum falling behind the churn, backup
// windows stretching, and a restore taking hours longer than the runbook says.
//
// It also matters more than it looks for confidentiality. `outbox.payload`
// holds the message body as PLAINTEXT JSON, while `messages.body_enc` holds the
// same text encrypted (0006_column_encryption.sql). Retaining the outbox
// forever means the encrypted-at-rest property does not hold for the copy that
// outlives the original. Bounding the outbox bounds that exposure too.
//
// WHY THESE RETENTION LINES
// -------------------------
// Each table is kept for as long as something can still USE it, and not longer:
//
//   - outbox: published rows only, past the point where replaying them could
//     help. Unpublished and dead-lettered rows are NEVER touched — an
//     unpublished row is pending work and a dead-lettered one is the only
//     surviving copy of an event that failed to reach its consumers.
//   - consumed_events: the dedup window. A row's only job is to recognise a
//     redelivery, and Kafka cannot redeliver past its topic retention, so
//     anything older than that retention (plus margin) can never match again.
//   - idempotency_keys: the client-retry window. A retry arrives in seconds;
//     a day is already generous.
//
// WHY IT DELETES IN BATCHES
// -------------------------
// One unbounded DELETE against a table with hundreds of millions of rows takes
// a long transaction and a lot of locks, on tables the send path writes to.
// Bounded batches with a commit between them keep each transaction short, so
// the prune competes with live traffic for milliseconds at a time instead of
// minutes. Slower overall, which is the correct trade for a maintenance job.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/task-board/messaging-svc/internal/config"
)

// batchSize is how many rows one transaction deletes. Small enough that locks
// are held briefly on tables the send path writes to; large enough that a
// night's backlog clears in a reasonable number of round trips.
const batchSize = 10_000

// maxBatches bounds a single run so a first execution against years of history
// cannot run until morning. Hitting it is reported, not silent — a truncated
// prune that looks like a completed one is how a table keeps growing while a
// green cron job says otherwise.
const maxBatches = 500

// pauseBetweenBatches yields to live traffic. The prune is never urgent and the
// send path always is.
const pauseBetweenBatches = 50 * time.Millisecond

// A retention target: one table, one age rule, one reason.
type target struct {
	name string
	// where is the eligibility predicate. It MUST bound what it deletes by age
	// and MUST NOT match anything still in use — see the per-target comments.
	where     string
	retention time.Duration
	why       string
}

func targets() []target {
	return []target{
		{
			name: "outbox",
			// published_at IS NOT NULL is the load-bearing half. A NULL means
			// the row is still pending work, and a dead-lettered row is the
			// only surviving copy of an event that never reached its consumers
			// — deleting either would be destroying data, not reclaiming it.
			where:     `published_at IS NOT NULL AND published_at < now() - $1::interval`,
			retention: 7 * 24 * time.Hour,
			why: "published rows are spent: the event is on the topic, and Kafka's own " +
				"retention is the replay mechanism from here",
		},
		{
			name: "consumed_events",
			// The dedup window. Kafka cannot redeliver an event older than the
			// topic's retention, so past that a row can never match again.
			// Sized well beyond the 7-day topic retention so a deliberate
			// replay from the start of the log is still deduped correctly.
			where:     `consumed_at < now() - $1::interval`,
			retention: 30 * 24 * time.Hour,
			why:       "past Kafka's retention a redelivery cannot happen, so the row can never match",
		},
		{
			name:      "consumed_events_inbox_tasks",
			where:     `consumed_at < now() - $1::interval`,
			retention: 30 * 24 * time.Hour,
			why:       "same dedup window, separate consumer group",
		},
		{
			name: "idempotency_keys",
			// The client-retry window. A retry arrives within seconds; a day is
			// already generous, and the index this scans (idx_idempotency_keys_
			// created) exists for exactly this query.
			where:     `created_at < now() - $1::interval`,
			retention: 24 * time.Hour,
			why:       "a client retry arrives in seconds; past a day nothing will present the key again",
		},
	}
}

func main() {
	dryRun := flag.Bool("dry-run", false, "report what would be deleted without deleting it")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		log.Error("config invalid", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	pool, perr := pgxpool.New(ctx, cfg.DatabaseURL)
	if perr != nil {
		log.Error("connect failed", "err", perr)
		os.Exit(1)
	}
	defer pool.Close()

	failed := false
	for _, t := range targets() {
		if err := prune(ctx, pool, log, t, *dryRun); err != nil {
			// Keep going: the targets are independent, and one unprunable table
			// should not leave the other three growing.
			log.Error("prune failed", "table", t.name, "err", err)
			failed = true
		}
	}
	if failed {
		os.Exit(1)
	}
}

func prune(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, t target, dryRun bool) error {
	interval := fmt.Sprintf("%d seconds", int(t.retention.Seconds()))

	if dryRun {
		var n int64
		//nolint:gosec // G201: t.name and t.where come from the fixed list above, never from input
		q := fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s`, t.name, t.where)
		if err := pool.QueryRow(ctx, q, interval).Scan(&n); err != nil {
			return err
		}
		log.Info("prune_would_delete",
			"table", t.name, "rows", n, "retention", t.retention.String(), "why", t.why)
		return nil
	}

	// Delete a bounded set selected in a CTE rather than with a bare LIMIT:
	// `DELETE ... LIMIT` is not valid Postgres, and the CTE form also keeps the
	// row set stable for the duration of the statement.
	//
	// Keyed on `ctid`, the physical row address, rather than on a primary key.
	// The four targets have three different key shapes — outbox(id),
	// consumed_events(event_id), idempotency_keys(user_id, key) — and ctid is
	// the one identifier all of them share, so the batching logic stays a
	// single code path instead of a per-table special case.
	//
	// FOR UPDATE SKIP LOCKED so the prune never blocks, or is blocked by, a
	// poller holding rows it is mid-publish.
	//nolint:gosec // G201: t.name and t.where come from the fixed list above, never from input
	q := fmt.Sprintf(`
		WITH doomed AS (
		    SELECT ctid FROM %s WHERE %s
		    LIMIT %d
		    FOR UPDATE SKIP LOCKED
		)
		DELETE FROM %s t USING doomed d WHERE t.ctid = d.ctid`,
		t.name, t.where, batchSize, t.name)

	var total int64
	for i := 0; i < maxBatches; i++ {
		tag, err := pool.Exec(ctx, q, interval)
		if err != nil {
			return err
		}
		n := tag.RowsAffected()
		total += n
		if n < batchSize {
			log.Info("prune_done",
				"table", t.name, "deleted", total, "retention", t.retention.String())
			return nil
		}
		// Yield between batches so the prune interleaves with live traffic
		// rather than monopolising a connection and the table's locks.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pauseBetweenBatches):
		}
	}

	// Reported, never silent. A run that stopped at the ceiling has left rows
	// behind, and a prune that looks successful while the table keeps growing
	// is the failure this whole command exists to prevent.
	log.Warn("prune_hit_batch_ceiling",
		"table", t.name, "deleted", total, "max_batches", maxBatches,
		"detail", "rows remain; run again or raise the ceiling — the table is still growing")
	return nil
}
