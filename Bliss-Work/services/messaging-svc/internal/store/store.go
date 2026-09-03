// Package store implements all messagingdb persistence, the transactional outbox,
// and the visibility/conversation semantics.
package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/readcache"
	"github.com/task-board/messaging-svc/migrations"
)

// ErrForbidden indicates the caller is not permitted to act on the resource.
var ErrForbidden = errors.New("forbidden")

// Store wraps the pgx connection pool and the at-rest column Cryptor.
type Store struct {
	pool *pgxpool.Pool
	// replica is an optional read-only pool. nil when none is configured, in
	// which case readPool() hands back the primary and every query behaves
	// exactly as it did before replicas existed.
	replica *pgxpool.Pool
	crypto  *crypto.Cryptor

	// cache is the read cache. A nil *readcache.Cache is fully usable and
	// always misses, so every call site can use it unconditionally and a
	// deployment without REDIS_URL behaves exactly as it did before.
	cache *readcache.Cache
}

// WithReadCache attaches the read cache.
//
// A method rather than another constructor parameter because it is genuinely
// optional: without it the store behaves exactly as it always has, and every
// existing caller — including the tests — keeps working untouched. Same shape
// as api.Server.WithSharedRateLimits, for the same reason.
func (s *Store) WithReadCache(c *readcache.Cache) *Store {
	s.cache = c
	return s
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

// WithReplica attaches a read-only pool for lag-tolerant reads.
//
// Separate from New rather than another parameter, because a replica is
// optional and its absence must stay the trivially correct case: a Store built
// without one routes every read to the primary, which is exactly what this
// service did before replicas existed.
//
// The replica pool is sized SMALLER than the primary. It serves a handful of
// deliberately-chosen heavy reads, not the general query load, and connection
// slots on a replica are as finite as on a primary — a pool sized as though it
// carried everything would reserve backends it never uses while the primary,
// which does carry everything, is capped at 10.
func (s *Store) WithReplica(ctx context.Context, replicaURL string) error {
	if replicaURL == "" {
		return nil
	}
	cfg, err := pgxpool.ParseConfig(replicaURL)
	if err != nil {
		return fmt.Errorf("parse replica url: %w", err)
	}
	cfg.MaxConns = 5
	cfg.MinConns = 1
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("open replica pool: %w", err)
	}
	// Prove it answers before accepting it. A replica URL that points at
	// nothing would otherwise fail on the first user-facing read rather than at
	// boot, and only for the endpoints that opted into it — a partial outage
	// affecting a subset of pages is markedly harder to diagnose than a
	// refusal to start.
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return fmt.Errorf("ping replica: %w", err)
	}
	s.replica = pool
	return nil
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
func (s *Store) Close() {
	if s.replica != nil {
		s.replica.Close()
	}
	s.pool.Close()
}

// Pool exposes the underlying pgx pool so the idempotency middleware (and the
// internal-delivery handler in Phase 5) can share it without owning their own.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// MigrationLockKey is the advisory-lock key for the startup migration run.
// Every replica of every service uses the same string; the lock is scoped to a
// database and each service owns its own, so they never contend across services.
const MigrationLockKey = "taskboard:migrations"

// Migrate runs every embedded migration file in lexical order (idempotent SQL).
//
// ── Why this holds a lock, and why it is now one transaction ────────────────
// Every replica runs this on boot, and idempotent DDL is NOT the same thing as
// concurrency-safe DDL. Two pods issuing `CREATE INDEX IF NOT EXISTS` against
// the same relation do not both quietly no-op — they take conflicting locks and
// one dies with a deadlock or `tuple concurrently updated`, which crash-loops
// the pod. Rolling deploys and HPA scale-ups start pods together BY DESIGN, so
// this is the ordinary case rather than a race that needs bad luck.
//
// This service has the most DDL to collide over — sixteen migration files
// including a 64-partition DO block in 0003 — and, because the media backend
// pins it to one replica today, it is also the service most likely to meet this
// for the first time on the deploy that finally scales it out.
//
// The previous shape could not be fixed by adding the lock alone. `pool.Exec`
// per file runs each statement on its own implicitly-committed transaction, so
// a `pg_advisory_xact_lock` taken that way would be released before the next
// file was read — decorative, in exactly the way this service's own outbox
// claim was before it got a real transaction. The whole run therefore moves
// inside one tx.
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
//
// ── Why there is now a ledger ────────────────────────────────────────────────
// This used to execute EVERY file on EVERY boot and rely on the SQL being
// idempotent. That works, and it costs more than it looks:
//
//   - Idempotent DDL is not free DDL. `ALTER TABLE messages ADD COLUMN IF NOT
//     EXISTS` still takes an ACCESS EXCLUSIVE lock on the hottest table in the
//     product before deciding to do nothing — on every pod start. Anything
//     mid-flight queues behind it, and anything arriving queues behind that.
//   - The whole run is serialised behind one advisory lock, so N pods starting
//     together cost N × the entire DDL suite. Rolling deploys and HPA
//     scale-ups start pods together BY DESIGN, which means boot time degrades
//     exactly when capacity is most needed.
//   - Boot time grows with the number of migrations forever, and this service
//     already has seventeen files including a 64-partition DO block.
//
// The ledger makes a steady-state boot a single SELECT. The lock and the single
// transaction stay: they are what make a first boot, or a boot that has genuine
// work to do, safe against a concurrent pod.
//
// The backfill is deliberately trivial. On the first boot after this ships the
// ledger is empty, so every file runs exactly as it always has and is then
// recorded — one more full run, and never again.
func (s *Store) Migrate(ctx context.Context) error {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	tx, err := s.pool.Begin(ctx)
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

	// Migrations run under BYPASS RLS, transaction-locally.
	//
	// Not cosmetic. `messaging_user` is a plain LOGIN role (no SUPERUSER, no
	// BYPASSRLS) and every org table is ENABLE + *FORCE* ROW LEVEL SECURITY, so
	// the policy applies to the table owner too. Without this, any DML inside a
	// migration — a backfill, a repair, a one-shot correction — matches ZERO
	// rows, because `app.org_id` is unset and the 0007 policy is fail-closed.
	//
	// It fails SILENTLY: `UPDATE 0` is a successful statement, so the migration
	// commits, the ledger records it as applied, and the data is untouched.
	// That is exactly how 0014_message_features.sql's one-shot "hide the
	// pre-origin THREAD rows" backfill did nothing at all while marking itself
	// done — see 0020_hide_chat_inbox_items.sql, which repairs it.
	//
	// DDL is unaffected either way; is_local=true keeps the bypass inside this
	// transaction, so it can never leak onto the pooled connection afterwards.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		return fmt.Errorf("set migration rls bypass: %w", err)
	}

	// The ledger itself. Created inside the same lock and transaction as
	// everything else, so two pods racing a first boot cannot both create it.
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
		sqlBytes, err := migrations.FS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		sum := fmt.Sprintf("%x", sha256.Sum256(sqlBytes))

		if prev, seen := applied[name]; seen && prev == sum {
			continue
		}
		// An edited migration re-runs, which is exactly what happened before
		// this ledger existed, so the behaviour is unchanged and the files are
		// all idempotent. What is new is that it is no longer SILENT: editing
		// an applied migration is nearly always a mistake (the change does not
		// reach databases that already ran it), and this is the only place it
		// can be noticed.
		if prev, seen := applied[name]; seen && prev != sum {
			slog.Warn("migration file changed after it was applied; re-running it",
				"file", name,
				"detail", "databases that already applied the old version will not "+
					"receive the difference unless the statements are idempotent — "+
					"prefer a new migration file")
		}

		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
			 ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum,
			                                      applied_at = now()`,
			name, sum); err != nil {
			return fmt.Errorf("record %s: %w", name, err)
		}
	}
	return tx.Commit(ctx)
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
	return s.withOrgOn(ctx, s.pool, orgID, fn)
}

// ── Read replicas ────────────────────────────────────────────────────────────
//
// A single Postgres handles roughly 10k writes/sec on good hardware, and this
// is the busiest service in the platform. Replicas do not raise that ceiling —
// only sharding does — but they take the heavy READS off the primary, which is
// what buys headroom while sharding is planned.
//
// ── The rule for using this ──────────────────────────────────────────────────
// A replica lags. Usually by milliseconds, occasionally by seconds under load,
// and there is no bound you can rely on. So the question for any query is not
// "is this a read" but "would this be WRONG if it returned state from one
// second ago".
//
// READ-AFTER-WRITE IS THE TRAP, and it is the common case here rather than an
// edge case: someone sends a message and their client immediately refetches the
// thread. Route that to a replica and the message they just sent is missing.
// The same applies to opening a conversation after marking it read, to a
// channel list after joining one, and to a call roster after being added.
//
// Route by INTENT, not by verb. That is why there is no blanket "all reads go
// to the replica" switch: every call site opts in individually, and the default
// stays on the primary, so a query added later is correct until someone has
// thought about it.
//
// withReplicaOrg is withOrg against the replica pool. It falls back to the
// primary when no replica is configured, so a call site can opt in without
// checking whether one exists.
func (s *Store) withReplicaOrg(ctx context.Context, orgID string, fn func(pgx.Tx) error) error {
	return s.withOrgOn(ctx, s.readPool(), orgID, fn)
}

// readPool returns the replica pool, or the primary when none is configured.
func (s *Store) readPool() *pgxpool.Pool {
	if s.replica != nil {
		return s.replica
	}
	return s.pool
}

// HasReplica reports whether a read replica is configured, for a startup log.
func (s *Store) HasReplica() bool { return s.replica != nil }

func (s *Store) withOrgOn(
	ctx context.Context, pool *pgxpool.Pool, orgID string, fn func(pgx.Tx) error,
) error {
	tx, err := pool.Begin(ctx)
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

// withCaller is withOrg plus the caller's identity.
//
// Only the call tables need this. Their RLS policy (0015_calls.sql) grants read
// access to a call you are a PARTICIPANT of, which is the one place in this
// database where a row is legitimately visible across an org boundary — a
// cross-org meeting guest evaluates the policy with their own app.org_id, so
// org_id alone can never match and the participant disjunct is the only thing
// that can let them through.
//
// Everything else keeps using withOrg. app.user_id widens nothing on its own:
// no other policy references it, so setting it is inert outside the call tables.
func (s *Store) withCaller(ctx context.Context, orgID, userID string, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := setCallerGUC(ctx, tx, orgID, userID); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// setCallerGUC sets both app.org_id and app.user_id transaction-locally. Both
// use is_local => true so they reset at COMMIT, which is what keeps this safe
// behind a transaction-mode connection pooler.
//
// ONE statement, not two. set_config returns its value, so both settings ride a
// single round trip — and this runs at the head of every call-path transaction,
// where the endpoints are chatty enough for a saved round trip to matter. The
// two settings are also a pair: a transaction that had org_id but not yet
// user_id would evaluate the calls RLS policy against half its inputs, and
// merging them removes the window in which that is even expressible.
func setCallerGUC(ctx context.Context, tx pgx.Tx, orgID, userID string) error {
	_, err := tx.Exec(ctx,
		`SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
		orgID, userID)
	return err
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
//
// For a function that OWNS its transaction. A helper that widens somebody
// else's for a statement or two wants beginBypassGUC instead, so it can put the
// setting back rather than assume what it was.
func setBypassGUC(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
	return err
}

// beginBypassGUC turns `app.bypass_rls` on for a few statements in a
// transaction the caller owns, and reports what it was so restoreBypassGUC can
// put that value back.
//
// ── Why it reads the old value rather than assuming 'off' ────────────────────
// Assuming was the bug. rostersTx and clearLobbyTx used to end their widening
// with a hard `set_config(..., 'off')`, which is correct inside withCaller —
// 'off' IS what it was there — and a silent DOWNGRADE inside withBypass, where
// the whole transaction is supposed to be widened.
//
// It failed invisibly, because losing a bypass is not an error: every statement
// after the widened one simply matched nothing. endCallTx is the path where
// that mattered. Called from the sweeper or an SFU webhook it runs under
// withBypass, its clearLobbyTx cleared the bypass halfway through, and the
// UPDATE that closes out the roster then hit zero rows and the getCallTx at the
// end read its own just-ended call as invisible — ErrForbidden, rollback, and a
// call sweep that had never once succeeded in production.
//
// Two round trips rather than one on purpose. Reading and setting in a single
// target list would depend on Postgres evaluating it left to right, which is
// not promised, and getting that wrong the other way round leaves a bypass
// switched ON for the rest of somebody else's request.
func beginBypassGUC(ctx context.Context, tx pgx.Tx) (string, error) {
	var prev string
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(current_setting('app.bypass_rls', true), '')`).Scan(&prev); err != nil {
		return "", err
	}
	if err := setBypassGUC(ctx, tx); err != nil {
		return "", err
	}
	return prev, nil
}

// restoreBypassGUC puts `app.bypass_rls` back to the value beginBypassGUC read,
// ending the widening exactly where it started.
func restoreBypassGUC(ctx context.Context, tx pgx.Tx, prev string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', $1, true)`, prev)
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
	// LastMessageSenderID is who sent LastMessage — used by the client to tell
	// "I sent it" from "I received it" (e.g. the Link sent/Link received
	// preview label). Absent (empty) when there is no last message.
	LastMessageSenderID string `json:"lastMessageSenderId,omitempty"`
	// Cleared is true when the caller has cleared/hidden every message in this
	// conversation but it genuinely has history — the list shows a blank
	// preview rather than LastMessage (nil here) or a "no messages" placeholder.
	Cleared       bool  `json:"cleared"`
	Unread        int64 `json:"unread"`
	BlockedByMe   bool  `json:"blockedByMe"`
	BlockedByPeer bool  `json:"blockedByPeer"`
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
	// MessageKindScreenshotAttempt records that the sender's own client (web or
	// desktop) detected and refused a screenshot attempt while this chat/channel
	// was open. Same trust level as MessageKindCallMissed: senderID is always
	// the authenticated caller, so this can only ever be a client reporting on
	// itself, never forged onto someone else's thread.
	MessageKindScreenshotAttempt = "screenshot_attempt"
)

// ValidMessageKind reports whether a CLIENT-SUPPLIED kind is one we accept on
// the send path. Server-derived kinds are set through appendOpts.kind and are
// intentionally absent here — see MessageKindForwardExternal.
func ValidMessageKind(kind string) bool {
	return kind == MessageKindText || kind == MessageKindCallMissed || kind == MessageKindScreenshotAttempt
}

// screenshotAttemptBody is the ONLY text a MessageKindScreenshotAttempt
// message may ever carry — authored here from the sender's own PROJECTED
// name, never from the client's request body. Unlike MessageKindCallMissed
// (whose two possible bodies are fixed strings the client picks between, never
// free text), a screenshot notice is rendered as an authoritative-looking
// security pill, so trusting client-supplied text for it would let any member
// post a fabricated "security" notice — naming anyone, claiming anything —
// under cover of this kind. senderID cannot be forged (see the kind's own
// comment above), but the BODY could be, which is just as bad: nothing in the
// rendered pill shows who actually sent it, only the sentence itself. This is
// the same reasoning that keeps MessageKindForwardExternal out of
// ValidMessageKind entirely; screenshot_attempt has to stay client-triggerable
// (only the client's detector knows an attempt happened), so the fix here is
// authoring the content server-side instead, not removing the kind.
func screenshotAttemptBody(displayName, username string) string {
	name := displayName
	if name == "" {
		name = username
	}
	if name == "" {
		// Projection hasn't caught up yet — vanishingly rare, and still never
		// falls back to trusting the client's own text.
		name = "Someone"
	}
	return fmt.Sprintf("%s tried to take a screenshot", name)
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
	// IsForward marks a message delivered by forwarding someone else's. The
	// client labels it, because content shown under the forwarder's name with
	// no marker attributes it to them.
	IsForward bool `json:"isForward,omitempty"`
}

// ChannelDTO mirrors the canonical ChannelDTO contract.
//
// `IsLocked` mirrors `channels.is_locked` — false means anyone in the org
// can self-join, true means joining requires an explicit add by a current
// member. `IAmMember` is computed per-caller so the directory and "browse
// open channels" views can render the right CTA (Join vs Open vs Locked).
type ChannelDTO struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	MemberCount       int     `json:"memberCount"`
	LastMessage       *string `json:"lastMessage"`
	LastMessageAt     *string `json:"lastMessageAt"`
	LastMessageSender string  `json:"lastMessageSender,omitempty"`
	// LastMessageSenderID is the raw sender id behind LastMessageSender — used
	// by the client to tell "I sent the last message" from "I received it"
	// (e.g. the Link sent/Link received preview label) without relying on a
	// display name, which is user-editable and can collide between members.
	LastMessageSenderID string `json:"lastMessageSenderId,omitempty"`
	// Cleared is true when the caller has cleared/hidden every message in this
	// channel but it genuinely has history — the list shows a blank preview
	// rather than LastMessage (nil here) or the member-count placeholder.
	Cleared bool `json:"cleared"`
	// Unread is the caller's unread count for this channel — messages after
	// their channel_members.last_read_seq cursor (see MarkChannelRead /
	// 0028_channel_read_receipts.sql, which already tracks this cursor for
	// "Seen by" receipts). Mirrors ConversationDTO.Unread exactly.
	Unread    int64 `json:"unread"`
	IsLocked  bool  `json:"isLocked"`
	IAmMember bool  `json:"iAmMember"`
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
	// IsForward mirrors MessageDTO.IsForward.
	IsForward bool `json:"isForward,omitempty"`
	// DeletedForAll marks a tombstone. The body is empty on the wire when this
	// is set — the server does not decrypt a deleted message (channels_read.go).
	DeletedForAll bool `json:"deletedForAll,omitempty"`
	// Pinned marks a message a moderator has pinned for the whole channel.
	Pinned bool `json:"pinned,omitempty"`
	// ReplyToID is the message this one quotes, if any. Mirrors MessageDTO.ReplyToID.
	ReplyToID string `json:"replyToId,omitempty"`
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
