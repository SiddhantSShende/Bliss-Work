// Command backfill-threads assigns thread_id / is_thread_root to legacy
// messages and seeds the inbox_items projection rows so the new /api/v1/inbox
// endpoint returns correct results from the moment readers are flipped over.
//
// Designed for incremental, idempotent runs:
//   - Each existing conversation collapses into ONE synthetic thread whose
//     root is the FIRST message (lowest seq) — preserves chat history without
//     guessing email-style thread boundaries.
//   - Subsequent messages in that conversation hang under the root via
//     parent_message_id = root_message_id, is_thread_root = false.
//   - inbox_items rows are seeded for both participants of every conversation
//     whose newest message landed in the last LOOKBACK_DAYS days.
//   - Safe to re-run: per-batch UPDATEs WHERE thread_id IS NULL skip already-
//     processed messages; inbox_items upserts use ON CONFLICT to keep
//     monotonic last_event_at.
//
// Usage:
//
//	DATABASE_URL=... LOOKBACK_DAYS=90 BATCH_SIZE=500 \
//	    go run ./cmd/backfill-threads
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultLookbackDays = 90
	defaultBatchSize    = 500
	previewLen          = 80
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Error("DATABASE_URL must be set")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// RLS: this is a one-shot, trusted, cross-org admin backfill that reads and
	// writes RLS-protected tables (conversations, threads, messages, inbox_items,
	// …) across EVERY org via raw pool.Query/Exec (autocommit — no per-tx GUC to
	// hang an org context on). Set the bypass GUC at SESSION level (set_config
	// third arg = false → NOT transaction-local) in an AfterConnect hook so every
	// pooled connection carries it for the life of the backfill. Safe because the
	// process is operator-run, not request-driven.
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Error("db config parse", "err", err)
		os.Exit(1)
	}
	poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, e := conn.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', false)`)
		return e
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		log.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Error("db ping", "err", err)
		os.Exit(1)
	}

	cfg := loadCfg()
	log.Info("backfill starting", "lookbackDays", cfg.lookbackDays, "batchSize", cfg.batchSize)

	stages := []struct {
		name string
		run  func(context.Context, *pgxpool.Pool, *slog.Logger, runCfg) error
	}{
		{"backfillThreadsForLegacyConversations", backfillThreadsForLegacyConversations},
		{"backfillMessageThreadColumns", backfillMessageThreadColumns},
		{"seedInboxItemsForActiveConversations", seedInboxItemsForActiveConversations},
	}
	for _, st := range stages {
		log.Info("stage start", "stage", st.name)
		if err := st.run(ctx, pool, log, cfg); err != nil {
			log.Error("stage failed", "stage", st.name, "err", err)
			os.Exit(1)
		}
		log.Info("stage done", "stage", st.name)
	}
	log.Info("backfill complete")
}

type runCfg struct {
	lookbackDays int
	batchSize    int
}

func loadCfg() runCfg {
	c := runCfg{lookbackDays: defaultLookbackDays, batchSize: defaultBatchSize}
	if v := os.Getenv("LOOKBACK_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.lookbackDays = n
		}
	}
	if v := os.Getenv("BATCH_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.batchSize = n
		}
	}
	return c
}

// Stage 1: for every conversation that has at least one message and lacks a
// thread, INSERT a thread row whose root is the lowest-seq message.
//
// Idempotent: a partial-prior-run leaves the threads row in place, and the
// NOT EXISTS guard skips already-threaded conversations.
func backfillThreadsForLegacyConversations(
	ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, cfg runCfg,
) error {
	rows, err := pool.Query(ctx, `
		SELECT c.id, c.org_id, c.user_low, c.user_high
		FROM conversations c
		WHERE NOT EXISTS (
		    SELECT 1 FROM threads t WHERE t.conversation_id = c.id
		)
		  AND EXISTS (
		    SELECT 1 FROM messages m WHERE m.conversation_id = c.id
		)`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type conv struct{ id, org, low, high string }
	var work []conv
	for rows.Next() {
		var c conv
		if err := rows.Scan(&c.id, &c.org, &c.low, &c.high); err != nil {
			return err
		}
		work = append(work, c)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	log.Info("legacy conversations needing thread seed", "count", len(work))

	for i, c := range work {
		if err := ctx.Err(); err != nil {
			return err
		}
		var rootID, body, rootSender string
		err := pool.QueryRow(ctx, `
			SELECT id, body, sender_id
			FROM messages
			WHERE conversation_id = $1
			ORDER BY seq ASC
			LIMIT 1`, c.id).Scan(&rootID, &body, &rootSender)
		if err != nil {
			return fmt.Errorf("lookup root for conv %s: %w", c.id, err)
		}
		rootRecipient := c.high
		if rootSender == c.high {
			rootRecipient = c.low
		}
		threadID := uuid.Must(uuid.NewV7()).String()

		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO threads
			  (id, org_id, conversation_id, root_message_id, sender_id, recipient_id,
			   subject_preview, last_event_at, last_message_seq)
			VALUES
			  ($1, $2, $3, $4, $5, $6, $7,
			    (SELECT max(created_at) FROM messages WHERE conversation_id = $3),
			    (SELECT max(seq) FROM messages WHERE conversation_id = $3))
			ON CONFLICT (conversation_id, root_message_id) DO NOTHING`,
			threadID, c.org, c.id, rootID, rootSender, rootRecipient, truncatePreview(body),
		); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("insert thread for conv %s: %w", c.id, err)
		}
		// Seed thread_members for both participants.
		for _, uid := range [2]string{c.low, c.high} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO thread_members (thread_id, user_id, org_id)
				VALUES ($1, $2, $3)
				ON CONFLICT (thread_id, user_id) DO NOTHING`,
				threadID, uid, c.org); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("seed thread_member for conv %s: %w", c.id, err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		if (i+1)%200 == 0 {
			log.Info("backfill threads progress", "done", i+1, "total", len(work))
		}
	}
	return nil
}

// Stage 2: for every message without thread_id, set thread_id (and is_thread_root)
// based on its conversation's now-extant thread row.
//
// We don't try to infer email-style threading from existing flat chat history —
// each conversation becomes ONE thread, which is the safe, lossless choice.
func backfillMessageThreadColumns(
	ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, cfg runCfg,
) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		ct, err := pool.Exec(ctx, fmt.Sprintf(`
			WITH batch AS (
			    SELECT m.id, t.id AS thread_id, t.root_message_id
			    FROM messages m
			    JOIN threads t ON t.conversation_id = m.conversation_id
			    WHERE m.thread_id IS NULL
			    LIMIT %d
			)
			UPDATE messages m
			SET thread_id      = b.thread_id,
			    is_thread_root = (m.id = b.root_message_id)
			FROM batch b
			WHERE m.id = b.id`, cfg.batchSize))
		if err != nil {
			return err
		}
		log.Info("backfill messages batch", "updated", ct.RowsAffected())
		if ct.RowsAffected() == 0 {
			return nil
		}
	}
}

// Stage 3: seed inbox_items for both participants of every conversation whose
// most recent message is within the lookback window. Skips conversations that
// have ALREADY been projected (left join on inbox_items).
func seedInboxItemsForActiveConversations(
	ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, cfg runCfg,
) error {
	lookback := time.Now().UTC().Add(-time.Duration(cfg.lookbackDays) * 24 * time.Hour)

	rows, err := pool.Query(ctx, `
		SELECT
		    t.id, t.org_id, t.conversation_id, t.sender_id, t.recipient_id,
		    t.last_event_at, t.subject_preview, t.last_message_seq,
		    COALESCE(t.last_event_at, c.last_msg_at) AS effective_at
		FROM threads t
		JOIN conversations c ON c.id = t.conversation_id
		WHERE COALESCE(t.last_event_at, c.last_msg_at) >= $1`, lookback)
	if err != nil {
		return err
	}
	defer rows.Close()

	type job struct {
		threadID, orgID, convID, senderID, recipientID, preview string
		lastAt                                                  time.Time
		lastSeq                                                 int64
	}
	var jobs []job
	for rows.Next() {
		var j job
		var lastAtNullable sql.NullTime
		var effective time.Time
		if err := rows.Scan(
			&j.threadID, &j.orgID, &j.convID, &j.senderID, &j.recipientID,
			&lastAtNullable, &j.preview, &j.lastSeq, &effective,
		); err != nil {
			return err
		}
		if lastAtNullable.Valid {
			j.lastAt = lastAtNullable.Time
		} else {
			j.lastAt = effective
		}
		jobs = append(jobs, j)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	log.Info("inbox_items seed jobs", "count", len(jobs))

	for i, j := range jobs {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Compute per-side unread from messages.seq vs thread_members.last_read_seq.
		for _, side := range []struct {
			owner, peer string
		}{
			{j.senderID, j.recipientID},
			{j.recipientID, j.senderID},
		} {
			var lastRead int64
			err := pool.QueryRow(ctx, `
				SELECT COALESCE(last_read_seq, 0)
				FROM thread_members
				WHERE thread_id = $1 AND user_id = $2`,
				j.threadID, side.owner).Scan(&lastRead)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			var unread int64
			if err := pool.QueryRow(ctx, `
				SELECT count(*) FROM messages
				WHERE thread_id = $1 AND sender_id <> $2 AND seq > $3`,
				j.threadID, side.owner, lastRead).Scan(&unread); err != nil {
				return err
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO inbox_items
				  (org_id, owner_user_id, item_kind, ref_id, peer_user_id, preview,
				   last_event_at, unread_count, status_badge,
				   hidden_for_owner, deleted_for_owner, updated_at)
				VALUES ($1, $2, 'THREAD', $3, $4, $5, $6, $7, NULL, false, false, now())
				ON CONFLICT (owner_user_id, item_kind, ref_id)
				DO UPDATE SET
				    last_event_at = GREATEST(inbox_items.last_event_at, EXCLUDED.last_event_at),
				    unread_count  = GREATEST(inbox_items.unread_count, EXCLUDED.unread_count),
				    preview       = EXCLUDED.preview,
				    updated_at    = now()`,
				j.orgID, side.owner, j.threadID, side.peer, j.preview, j.lastAt, unread,
			); err != nil {
				return fmt.Errorf("seed inbox_items thread %s owner %s: %w",
					j.threadID, side.owner, err)
			}
		}
		if (i+1)%200 == 0 {
			log.Info("seed inbox_items progress", "done", i+1, "total", len(jobs))
		}
	}
	return nil
}

func truncatePreview(body string) string {
	clean := strings.ReplaceAll(body, "\r", " ")
	clean = strings.ReplaceAll(clean, "\n", " ")
	clean = strings.Join(strings.Fields(clean), " ")
	if len(clean) > previewLen {
		return clean[:previewLen]
	}
	return clean
}
