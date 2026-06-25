// Package store implements all messagingdb persistence, the transactional outbox,
// and the visibility/conversation semantics.
package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/migrations"
)

// ErrForbidden indicates the caller is not permitted to act on the resource.
var ErrForbidden = errors.New("forbidden")

// Store wraps the pgx connection pool and the at-rest column Cryptor.
type Store struct {
	pool   *pgxpool.Pool
	crypto *crypto.Cryptor
}

// New opens a pgx pool against the given URL. The Cryptor encrypts sensitive
// columns on write and decrypts on read transparently; it is required (a nil
// Cryptor would write NULL ciphertext and lose message bodies).
func New(ctx context.Context, dbURL string, cryptor *crypto.Cryptor) (*Store, error) {
	if cryptor == nil {
		return nil, errors.New("store.New: cryptor is required")
	}
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool, crypto: cryptor}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Ping checks DB connectivity.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Pool exposes the underlying pgx pool so the idempotency middleware (and the
// internal-delivery handler in Phase 5) can share it without owning their own.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Migrate runs every embedded migration file in lexical order (idempotent SQL).
func (s *Store) Migrate(ctx context.Context) error {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && len(e.Name()) > 4 && e.Name()[len(e.Name())-4:] == ".sql" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		sqlBytes, err := migrations.FS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if _, err := s.pool.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
	}
	return nil
}

// ── RLS GUC plumbing ─────────────────────────────────────────────────────────
//
// Every org-scoped query path runs inside a transaction whose FIRST statement
// sets the per-transaction GUC `app.org_id` (SET LOCAL semantics via
// set_config(..., true)). The 0007_rls.sql policy compares each row's org_id to
// this GUC, so a missing SET LOCAL fails closed (0 rows) rather than leaking.
//
// Because set_config(..., true) is transaction-local it auto-resets on
// COMMIT/ROLLBACK and can never leak across the pooled connection's next use —
// the key property that makes a shared pgxpool safe under RLS.

// withOrg runs fn inside a transaction with `app.org_id` set to orgID. It is the
// canonical wrapper for org-scoped READS that previously used s.pool.Query /
// s.pool.QueryRow directly: wrapping them in a tx is the only way to attach the
// transaction-local GUC the RLS policy reads. Commits on success, rolls back on
// any error (including a panic-free fn error).
//
// IMPORTANT for callers that decrypt: pass the SAME tx to s.crypto.Encrypt /
// Decrypt so the org_keys lookup also runs under app.org_id (org_keys is RLS-
// protected). And do NOT issue a new query on the tx while a pgx.Rows from the
// same tx is still open ("conn busy") — buffer raw rows, Close(), then decrypt.
func (s *Store) withOrg(ctx context.Context, orgID string, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, orgID); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// withBypass runs fn inside a transaction with `app.bypass_rls` set to 'on'.
// Reserved for TRUSTED, non-request code that legitimately spans orgs:
//   - cross-org background workers (Kafka consumers, outbox poller, task
//     projector), and
//   - internal service-to-service endpoints that resolve the org FROM the row
//     they look up (delivery acks, channel-membership snapshots).
//
// NEVER call this on a path where the bypass decision could be influenced by
// request input. set_config(..., true) keeps the bypass transaction-local.
func (s *Store) withBypass(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// setOrgGUC sets `app.org_id` as the first statement inside an ALREADY-open tx.
// Used by the write methods that open their own s.pool.Begin tx (SendMessage,
// Reply, channel sends, ignore/read/dismiss, …) so the surrounding tx carries
// the org context the RLS policy needs.
func setOrgGUC(ctx context.Context, tx pgx.Tx, orgID string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, orgID)
	return err
}

// setBypassGUC sets `app.bypass_rls = 'on'` as the first statement inside an
// already-open tx. Same trust rules as withBypass.
func setBypassGUC(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
	return err
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

// SendResult is returned to the API after a send/reply.
type SendResult struct {
	ConversationID string `json:"conversationId"`
	ThreadID       string `json:"threadId,omitempty"`
	MessageID      string `json:"messageId"`
	Seq            int64  `json:"seq"`
}

// ConversationDTO mirrors the canonical ConversationDTO contract.
type ConversationDTO struct {
	ID            string  `json:"id"`
	PeerID        string  `json:"peerId"`
	PeerUsername  string  `json:"peerUsername"`
	LastMessage   *string `json:"lastMessage"`
	LastMessageAt *string `json:"lastMessageAt"`
	Unread        int64   `json:"unread"`
}

// MessageDTO mirrors the canonical MessageDTO contract. The threading
// fields (ThreadID, ParentMessageID, IsThreadRoot) are omitempty so legacy
// /conversations/{id}/messages keeps emitting clean JSON for old clients.
type MessageDTO struct {
	ID                string  `json:"id"`
	ConversationID    string  `json:"conversationId"`
	ThreadID          string  `json:"threadId,omitempty"`
	ParentMessageID   *string `json:"parentMessageId,omitempty"`
	IsThreadRoot      bool    `json:"isThreadRoot,omitempty"`
	Seq               int64   `json:"seq"`
	SenderID          string  `json:"senderId"`
	Body              string  `json:"body"`
	CreatedAt         string  `json:"createdAt"`
	DismissedBySender bool    `json:"dismissedBySender,omitempty"`
}

// ChannelDTO mirrors the canonical ChannelDTO contract.
//
// `IsLocked` mirrors `channels.is_locked` — false means anyone in the org
// can self-join, true means joining requires an explicit add by a current
// member. `IAmMember` is computed per-caller so the directory and "browse
// open channels" views can render the right CTA (Join vs Open vs Locked).
type ChannelDTO struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	MemberCount   int     `json:"memberCount"`
	LastMessage   *string `json:"lastMessage"`
	LastMessageAt *string `json:"lastMessageAt"`
	IsLocked      bool    `json:"isLocked"`
	IAmMember     bool    `json:"iAmMember"`
}

// ChannelMessageDTO mirrors the canonical ChannelMessageDTO contract.
type ChannelMessageDTO struct {
	ID             string `json:"id"`
	ChannelID      string `json:"channelId"`
	Seq            int64  `json:"seq"`
	SenderID       string `json:"senderId"`
	SenderUsername string `json:"senderUsername"`
	Body           string `json:"body"`
	CreatedAt      string `json:"createdAt"`
}

// ChannelSendResult is returned to the API after a channel message send.
type ChannelSendResult struct {
	MessageID string `json:"messageId"`
	Seq       int64  `json:"seq"`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func orderedPair(a, b string) (low, high string) {
	if a < b {
		return a, b
	}
	return b, a
}
