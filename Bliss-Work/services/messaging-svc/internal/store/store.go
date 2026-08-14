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
	// Pin the pool explicitly. pgxpool.New defaults MaxConns to
	// max(4, runtime.NumCPU()), which silently couples this service's share of
	// a finite Postgres connection budget to whatever hardware it lands on —
	// the same pool on a 32-core host would quietly claim 32 backends. This is
	// the busiest service in the platform, so it gets the largest single share;
	// see auth-svc/app/db.py for the platform-wide arithmetic.
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	poolCfg.MaxConns = 10
	poolCfg.MinConns = 2
	poolCfg.MaxConnLifetime = 30 * time.Minute
	poolCfg.MaxConnIdleTime = 5 * time.Minute
	poolCfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool, crypto: cryptor}, nil
}

// NewUnconnected returns a Store with no database connection.
//
// FOR TESTS ONLY. It exists so api.Server.Router() can be constructed in a unit
// test that inspects routing and middleware wiring without a live Postgres —
// notably the body-cap regression tests, which have to exercise the REAL router
// to be worth anything. Any method that touches the pool will panic, which is
// the intended failure mode: a test that reaches the database with this Store
// is a test that should have been an integration test.
func NewUnconnected() *Store { return &Store{} }

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
//
// BlockedByMe = the caller blocked the peer ("You blocked this user").
// BlockedByPeer = the peer blocked the caller ("You have been blocked").
// Sends are gated whenever EITHER is true.
type ConversationDTO struct {
	ID           string `json:"id"`
	PeerID       string `json:"peerId"`
	PeerUsername string `json:"peerUsername"`
	// PeerDisplayName is the peer's real name. `username` is DERIVED FROM THE
	// EMAIL LOCAL-PART at signup (auth-svc routes/auth.py), so rendering it in
	// chat shows "j.okafor" where "Jane Okafor" belongs. user_projection has
	// carried display_name all along; it simply was never selected.
	// Empty when the projection has not caught up — clients fall back to
	// peerUsername.
	PeerDisplayName string  `json:"peerDisplayName,omitempty"`
	LastMessage     *string `json:"lastMessage"`
	LastMessageAt   *string `json:"lastMessageAt"`
	Unread          int64   `json:"unread"`
	BlockedByMe     bool    `json:"blockedByMe"`
	BlockedByPeer   bool    `json:"blockedByPeer"`
}

// MessageDTO mirrors the canonical MessageDTO contract. The threading
// fields (ThreadID, ParentMessageID, IsThreadRoot) are omitempty so legacy
// /conversations/{id}/messages keeps emitting clean JSON for old clients.
// Message kinds. 'text' is an ordinary message someone typed; the others are
// system entries the UI renders as a centered pill rather than a chat bubble.
const (
	MessageKindText       = "text"
	MessageKindCallMissed = "call_missed"
	// MessageKindForwardExternal records that a message was handed off to an
	// external app (currently a WhatsApp deep link). Deliberately NOT in
	// ValidMessageKind: the pill names a recipient and shows a phone number, so
	// a client able to post one directly could forge "Forwarded to IT Support
	// (+1800…)" in someone else's thread. Only ForwardLinkRecord sets it.
	MessageKindForwardExternal = "forward_external"
)

// ValidMessageKind reports whether a CLIENT-SUPPLIED kind is one we accept on
// the send path. Server-derived kinds are set through appendOpts.kind and are
// intentionally absent here — see MessageKindForwardExternal.
func ValidMessageKind(kind string) bool {
	return kind == MessageKindText || kind == MessageKindCallMissed
}

type MessageDTO struct {
	ID                string  `json:"id"`
	Kind              string  `json:"kind,omitempty"`
	ConversationID    string  `json:"conversationId"`
	ThreadID          string  `json:"threadId,omitempty"`
	ParentMessageID   *string `json:"parentMessageId,omitempty"`
	IsThreadRoot      bool    `json:"isThreadRoot,omitempty"`
	Seq               int64   `json:"seq"`
	SenderID          string  `json:"senderId"`
	Body              string  `json:"body"`
	CreatedAt         string  `json:"createdAt"`
	DismissedBySender bool    `json:"dismissedBySender,omitempty"`
	// Status is the sender-side delivery state — SENT | DELIVERED | SEEN — and
	// is set ONLY on the caller's own messages. Empty for anything they
	// received, where the question is meaningless.
	//
	// It comes from the server rather than being accumulated client-side from
	// live events, because the client's copy dies with the page: a receipt that
	// only exists in a cache patch is gone the moment the thread is reopened,
	// which is why sent messages showed no state at all after a reload.
	Status string `json:"status,omitempty"`
	// ReplyToID is the message this one quotes, if any.
	ReplyToID string `json:"replyToId,omitempty"`
	// DeletedForAll marks a tombstone. The row still travels — seq is the
	// conversation's ordering key and other tables reference the id — but Body
	// is empty and never leaves the server, so the client renders "this message
	// was deleted" in place rather than showing a gap it can't explain.
	DeletedForAll bool `json:"deletedForAll,omitempty"`
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
	// Who created the channel. Written since 0002 and, until channel roles
	// existed, never once read back.
	CreatedBy string `json:"createdBy"`
	// The CALLER's role in this channel — "" when they are not a member. What
	// the UI gates the moderation controls on; the server re-checks regardless.
	MyRole string `json:"myRole"`
}

// ChannelMessageDTO mirrors the canonical ChannelMessageDTO contract.
type ChannelMessageDTO struct {
	ID             string `json:"id"`
	ChannelID      string `json:"channelId"`
	Seq            int64  `json:"seq"`
	SenderID       string `json:"senderId"`
	SenderUsername string `json:"senderUsername"`
	// Real name; see ConversationDTO.PeerDisplayName for why username alone is
	// the wrong thing to render. Empty until the projection catches up.
	SenderDisplayName string `json:"senderDisplayName,omitempty"`
	Body              string `json:"body"`
	CreatedAt         string `json:"createdAt"`
	// Kind mirrors MessageDTO.Kind — omitted for ordinary text so the wire
	// shape of a normal channel message is unchanged.
	Kind string `json:"kind,omitempty"`
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
