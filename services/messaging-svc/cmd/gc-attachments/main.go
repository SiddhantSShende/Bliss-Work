// Command gc-attachments reclaims disk from chat attachments that were uploaded
// but never referenced by a sent message.
//
// ── Why this is necessary at all ─────────────────────────────────────────────
// An attachment is linked to its message by an id embedded in the message BODY,
// and message bodies are encrypted at rest (messages.body_enc). The server
// therefore cannot read a message to discover which attachments it references,
// which means it can never answer "is this blob still reachable?" by inspection.
//
// So uploads are expiring by default: CreateAttachment sets
// expires_at = now() + MEDIA_UPLOAD_TTL, and the client clears it via
// POST /attachments/{id}/commit once the message has actually been accepted. A
// user who picks a file and then changes their mind leaves a row that lapses,
// and this command sweeps it.
//
// Deleting the row is not enough: the blob is content-addressed and may be
// shared by other attachments in the same org, so a file is unlinked only when
// no surviving row in that org still points at it (the store's reaper query
// does that check as part of the same statement).
//
// Idempotent and safe to re-run. Intended as a daily cron:
//
//	MESSAGING_DATABASE_URL=... MEDIA_ROOT=/var/lib/blisswork/media \
//	    go run ./cmd/gc-attachments
//
// Set GC_DRY_RUN=1 to report what would be reclaimed without deleting anything.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/config"
	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("config load failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The Cryptor is required by store.New but unused here: the reaper touches
	// only ids, hashes and timestamps, never a filename.
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

	st, err := store.New(ctx, cfg.DatabaseURL, cryptor)
	if err != nil {
		log.Error("db connect failed", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	blobs, err := blob.New(cfg.Media.Root)
	if err != nil {
		log.Error("blob store init failed", "err", err, "root", cfg.Media.Root)
		os.Exit(1)
	}

	dryRun := os.Getenv("GC_DRY_RUN") != ""
	batch := 500
	if v := os.Getenv("GC_BATCH_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			batch = n
		}
	}

	start := time.Now()
	var rows, unlinked, failed int

	// Loop until a batch comes back short, so a large backlog drains in one run
	// without ever holding a huge transaction open.
	for {
		if ctx.Err() != nil {
			log.Warn("interrupted; stopping early")
			break
		}
		if dryRun {
			log.Info("dry run: skipping deletion")
			break
		}

		expired, err := st.ReapExpiredAttachments(ctx, batch)
		if err != nil {
			log.Error("reap query failed", "err", err)
			os.Exit(1)
		}
		if len(expired) == 0 {
			break
		}
		rows += len(expired)

		for _, b := range expired {
			if err := blobs.Remove(b.OrgID, b.SHA256); err != nil {
				// The row is already gone, so a failed unlink leaks a file but
				// never breaks a live attachment. Log and carry on; the orphan
				// is reported so an operator can sweep it by hand.
				failed++
				log.Warn("blob unlink failed", "err", err, "org_id", b.OrgID, "sha256", b.SHA256)
				continue
			}
			unlinked++
		}
		if len(expired) < batch {
			break
		}
	}

	log.Info("gc-attachments finished",
		"rows_deleted", rows,
		"blobs_unlinked", unlinked,
		"unlink_failures", failed,
		"dry_run", dryRun,
		"duration_ms", time.Since(start).Milliseconds())
}
