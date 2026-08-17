package db

import (
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Connect opens a pgx connection pool to the given database URL with explicit
// pool sizing and lifetimes so the service behaves predictably under load.
func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse pgx config: %w", err)
	}
	// 10, down from 25. This service is a Kafka consumer plus an outbox poller,
	// neither of which needs 25 concurrent backends — and it was the single
	// largest contributor to a platform-wide pool total of 121 against a
	// Postgres that allowed 97. See auth-svc/app/db.py for the full arithmetic.
	poolCfg.MaxConns = 10
	poolCfg.MinConns = 2
	poolCfg.MaxConnLifetime = 30 * time.Minute
	poolCfg.MaxConnIdleTime = 5 * time.Minute
	poolCfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return pool, nil
}

// MigrationLockKey is the advisory-lock key for the startup migration run.
// Every replica of every service uses the same string; the lock is scoped to a
// database and each service owns its own, so they never contend across services.
const MigrationLockKey = "taskboard:migrations"

// Migrate runs all embedded SQL migrations in lexicographic order. Each
// migration is expected to be idempotent (CREATE ... IF NOT EXISTS).
//
// ── Why this holds a lock, and why it is now one transaction ────────────────
// Every replica runs this on boot, and idempotent DDL is NOT the same thing as
// concurrency-safe DDL. Two pods issuing `CREATE INDEX IF NOT EXISTS` against
// the same relation do not both quietly no-op — they take conflicting locks and
// one dies with a deadlock or `tuple concurrently updated`, which crash-loops
// the pod. Rolling deploys and HPA scale-ups start pods together BY DESIGN, so
// this is the ordinary case rather than a race that needs bad luck.
//
// The previous shape could not be fixed by adding the lock alone. `pool.Exec`
// per file runs each statement on its own implicitly-committed transaction, so
// a `pg_advisory_xact_lock` taken that way would be released before the next
// file was read — the clause would be decorative, in exactly the way the outbox
// pollers' `FOR UPDATE SKIP LOCKED` was before it got a real transaction. The
// whole run therefore moves inside one tx.
//
// Transaction-scoped, never the session variant: it releases at commit with no
// cleanup path to get wrong, and it stays correct under PgBouncer transaction
// pooling, where a session-level lock would be taken on one backend and
// released on another (which is to say, never).
//
// Making the run atomic is a deliberate side effect and an improvement: a
// failure halfway through no longer leaves the schema in a state no migration
// file describes. Every migration here is transaction-safe (no CREATE INDEX
// CONCURRENTLY, no VACUUM), which is the precondition — check it before adding
// one that is not.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// FIRST statement in the transaction, before any DDL is attempted. A second
	// pod blocks here and then finds every migration already applied.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, MigrationLockKey); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}

	// ── The ledger ───────────────────────────────────────────────────────────
	// This used to execute EVERY file on EVERY boot and rely on the SQL being
	// idempotent. That is correct and not free: idempotent DDL still takes the
	// same locks before deciding to do nothing, the whole run is serialised
	// behind the advisory lock above, and rolling deploys and HPA scale-ups
	// start pods together by design — so boot cost was N pods × the entire DDL
	// suite, precisely when capacity was needed.
	//
	// With the ledger, a steady-state boot is one SELECT. The lock and the
	// single transaction stay: they are what make a first boot, or a boot with
	// real work to do, safe against a concurrent pod.
	//
	// Backfill is trivial — on the first boot after this ships the ledger is
	// empty, every file runs exactly as before, and is then recorded.
	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename   text PRIMARY KEY,
			checksum   text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT filename, checksum FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var name, sum string
		if err := rows.Scan(&name, &sum); err != nil {
			rows.Close()
			return fmt.Errorf("scan schema_migrations: %w", err)
		}
		applied[name] = sum
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}

	for _, name := range names {
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		sum := fmt.Sprintf("%x", sha256.Sum256(sqlBytes))
		if prev, seen := applied[name]; seen {
			if prev == sum {
				continue
			}
			// Re-runs, which is what happened before this ledger existed — but
			// no longer silently. Editing an applied migration is nearly always
			// a mistake: the change never reaches databases that already ran it.
			slog.Warn("migration file changed after it was applied; re-running it",
				"file", name,
				"detail", "prefer a new migration file — databases that already "+
					"applied the old version will not receive the difference")
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("exec migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
			 ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum,
			                                      applied_at = now()`,
			name, sum); err != nil {
			return fmt.Errorf("record migration %s: %w", name, err)
		}
	}
	return tx.Commit(ctx)
}
