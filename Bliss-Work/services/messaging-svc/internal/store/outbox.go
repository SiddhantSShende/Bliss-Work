package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/readcache"
)

// NOTE on RLS for this file:
//   - outbox, consumed_events, consumed_events_inbox_tasks have NO org_id and
//     get NO RLS policy in 0007_rls.sql, so FetchUnpublished / MarkPublished /
//     MarkConsumed / MarkConsumedInboxTasks need no GUC and stay plain pool ops.
//   - user_projection DOES carry org_id (RLS-protected); UpsertUser therefore
//     runs under BYPASS (cross-org background consumer).
//   - insertOutbox writes the outbox row on the CALLER's tx, which already has
//     app.org_id (writes) or bypass set; outbox itself is un-policied anyway.

// insertOutbox writes a fully-formed event into the outbox within the given tx.
func insertOutbox(ctx context.Context, tx pgx.Tx, key string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO outbox (id, topic, kafka_key, payload) VALUES ($1, $2, $3, $4)`,
		uuid.Must(uuid.NewV7()).String(), events.TopicMessaging, key, raw)
	return err
}

// insertOutboxBatch writes many fully-formed events into the outbox in ONE
// round trip, all under the caller's transaction.
//
// The batch form of insertOutbox, and it exists because the row-at-a-time form
// made bulk operations quadratic in round trips: adding 500 people to a channel
// emitted 500 ChannelMemberJoined events and paid a statement for each, inside
// a transaction whose locks and snapshot were held for the whole sequence.
//
// The EVENTS stay individual — each names one person, and batching them into a
// single event would be a contract change for every consumer, for no benefit —
// only the insert is batched. Order is preserved, and every row shares the
// caller's kafka key so per-key ordering on the topic is unchanged.
func insertOutboxBatch(ctx context.Context, tx pgx.Tx, key string, payloads []any) error {
	if len(payloads) == 0 {
		return nil
	}
	ids := make([]string, len(payloads))
	raws := make([][]byte, len(payloads))
	for i, p := range payloads {
		raw, err := json.Marshal(p)
		if err != nil {
			return err
		}
		ids[i] = uuid.Must(uuid.NewV7()).String()
		raws[i] = raw
	}
	// unnest over parallel arrays: one statement, one parse, one plan, however
	// many rows. WITH ORDINALITY is unnecessary — outbox ordering is by
	// created_at and then by the poller's ORDER BY, and these all share an
	// instant; per-key ordering on Kafka is what actually matters and is
	// preserved by the shared key.
	_, err := tx.Exec(ctx,
		`INSERT INTO outbox (id, topic, kafka_key, payload)
		 SELECT u.id, $2, $3, u.payload
		   FROM unnest($1::uuid[], $4::jsonb[]) AS u(id, payload)`,
		ids, events.TopicMessaging, key, raws)
	return err
}

// ── Projection upsert (consumer) ───────────────────────────────────────────────

// UpsertUser stores/updates a user_projection row (from auth user.created).
//
// RLS: this runs in the AuthConsumer — a cross-org BACKGROUND Kafka consumer
// (it projects user.created for every org off one stream). user_projection is
// RLS-protected, so it runs under BYPASS. (The orgID arg is the row's org, not
// a request-scoped caller org, so it is NOT used to scope app.org_id.)
// `email` may be empty — events produced before auth-svc carried the address
// still replay off the topic. NULLIF + COALESCE below keep an empty one from
// blanking an address the backfill already wrote, which is what makes replaying
// the topic safe rather than destructive.
func (s *Store) UpsertUser(ctx context.Context, userID, orgID, username, displayName, email string) error {
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name, email)
			 VALUES ($1, $2, $3, $4, NULLIF(lower($5), ''))
			 ON CONFLICT (user_id) DO UPDATE
			 SET org_id = EXCLUDED.org_id, username = EXCLUDED.username, display_name = EXCLUDED.display_name,
			     email = COALESCE(EXCLUDED.email, user_projection.email)`,
			userID, orgID, username, displayName, email)
		return err
	}); err != nil {
		return err
	}
	// AFTER the commit, never before. Invalidating first opens a window in which
	// a concurrent read repopulates the cache from the pre-commit state and then
	// nothing invalidates it again — the stale value would then live for the
	// full TTL rather than being corrected on the next read.
	//
	// This is the signal that makes the read cache worth having: names change
	// only when auth-svc says so, and this consumer is where it says so. Without
	// it the TTL would have to be short enough to be nearly useless.
	readcache.Del(ctx, s.cache, readcache.UserKey(orgID, userID))
	return nil
}

// SetUserActive flips user_projection.active for a membership lifecycle event
// (user.deactivated / user.reactivated / user.removed).
//
// The row is never deleted: messages, channel memberships and forward chains
// all reference user_id, and their sender names are resolved through this
// projection — dropping the row would blank the history a departed member left
// behind. Same cross-org BYPASS reasoning as UpsertUser above.
//
// Deliberately does NOT invalidate the read cache, and the reason is narrow
// enough to be worth stating: the cache holds only `username` and
// `display_name`, and this touches neither. A deactivated member keeps the name
// their past messages are rendered under — that is the whole point of not
// deleting the row — so there is nothing cached here that has become wrong.
//
// If `active` is ever added to the cached struct, this needs a Del and an orgID
// parameter to build the key with.
func (s *Store) SetUserActive(ctx context.Context, userID string, active bool) error {
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE user_projection SET active = $2 WHERE user_id = $1`,
			userID, active)
		return err
	})
}

// ── Consumer dedup ──────────────────────────────────────────────────────────────
//
// Split into a cheap read-only check and a claim, rather than one
// check-and-claim INSERT, because a caller now needs BOTH: a fast skip for an
// already-fully-applied redelivery (IsConsumed, before doing any work) and a
// claim that only lands once the work it is vouching for has actually
// succeeded (MarkConsumed, after). Claiming up front — the shape this used to
// have — makes a genuine write failure indistinguishable from success the
// moment the SAME event is redelivered: the claim is already there, so the
// retry that redelivery exists to provide never happens.

// IsConsumed reports whether an event has already been durably processed. Not
// a claim — call MarkConsumed once the work it precedes has succeeded.
func (s *Store) IsConsumed(ctx context.Context, eventID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM consumed_events WHERE event_id = $1)`, eventID).Scan(&exists)
	return exists, err
}

// MarkConsumed claims an event_id; returns false if it was already claimed
// (a benign race between two callers who both passed the IsConsumed check).
func (s *Store) MarkConsumed(ctx context.Context, eventID string) (bool, error) {
	ct, err := s.pool.Exec(ctx,
		`INSERT INTO consumed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}

// IsConsumedInboxTasks / MarkConsumedInboxTasks dedup events in the *task
// projector* consumer group, kept separate from the auth-projection dedup so
// two groups consuming overlapping eventIds don't collide on the per-event_id
// PK.
func (s *Store) IsConsumedInboxTasks(ctx context.Context, eventID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM consumed_events_inbox_tasks WHERE event_id = $1)`, eventID).Scan(&exists)
	return exists, err
}

func (s *Store) MarkConsumedInboxTasks(ctx context.Context, eventID string) (bool, error) {
	ct, err := s.pool.Exec(ctx,
		`INSERT INTO consumed_events_inbox_tasks (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}

// ── Outbox poller support ─────────────────────────────────────────────────────

// OutboxRow is one unpublished event.
type OutboxRow struct {
	ID      string
	Topic   string
	Key     string
	Payload []byte
}

// DrainOptions bounds what the poller will keep trying.
//
// Both fields exist because a publish failure has two completely different
// causes and the old code treated them as one. A broker blip is transient and
// retrying is exactly right; a row the broker will never accept is permanent
// and retrying it forever stops the queue behind it. Without a way to tell them
// apart, the correct handling of the first became an outage from the second.
type DrainOptions struct {
	// MaxPayloadBytes quarantines a row BEFORE it is ever offered to the
	// producer. Deterministic and cheap: an oversized row is knowable from its
	// length, so there is no reason to learn it from N failed round trips —
	// and no reason to let it take the rest of its batch down with it, since
	// the producer rejects the whole WriteMessages call, not the one message.
	//
	// Zero disables the check.
	MaxPayloadBytes int

	// MaxAttempts quarantines a row after this many failed drains. This is the
	// backstop for permanent failures that are NOT about size — a topic that
	// does not exist, a payload the broker rejects for another reason — where
	// the only evidence is that it keeps failing.
	//
	// Zero disables the counter, restoring retry-forever.
	MaxAttempts int
}

// DrainStats reports what one drain did. Returned rather than logged in here so
// the caller owns the metrics namespace.
type DrainStats struct {
	Published    int
	DeadLettered int
}

// DrainUnpublished claims up to limit unpublished rows and hands the WHOLE
// BATCH to publish, in insertion order, marking them all once it succeeds.
//
// Claim and mark share ONE transaction, which is what lets `FOR UPDATE SKIP
// LOCKED` do its job: a second replica takes a different batch instead of
// re-publishing this one. (The previous shape — a bare pool Query followed by
// per-row Exec — could not be fixed by adding the clause alone, because outside
// an explicit transaction each statement commits on its own and the row locks
// would be gone before the first message was produced.)
//
// ── Why the batch, and not a row at a time ───────────────────────────────────
// This used to hand rows over one by one, which forced the caller into one
// Kafka write per row. A single-message write waits out the producer's batch
// timeout before it flushes, so the poller was pinned at roughly one message
// per BatchTimeout — around 20 events a second, for every event in the product.
// Handing over the slice lets the caller make one WriteMessages call, which is
// what notification-svc's publisher has always done.
//
// The trade is that the batch is now ALL-OR-NOTHING rather than committing the
// successful prefix: if publish fails, nothing is marked and the next tick
// retries the whole batch. Some of those rows may already be on the wire, so a
// retry can re-produce them — which is fine, because every consumer in the
// platform dedups on eventId and this is an at-least-once pipeline by design.
// Order is preserved either way, since the retry re-reads in created_at order.
//
// ── Why a permanent failure no longer stops the queue ────────────────────────
// "Retry the whole batch next tick" is right for a broker blip and catastrophic
// for a row the broker will never accept: the claim is `ORDER BY created_at`,
// so an unpublishable row is at the head of the queue on every tick, and every
// event behind it — across every topic and every organisation — stops with it,
// indefinitely. That is one bad row causing a total platform event outage, and
// producing one only took a large enough message body.
//
// So a failure is now classified rather than assumed transient. Oversized rows
// are quarantined before they are offered to the producer at all, because the
// producer rejects the ENTIRE WriteMessages call on one oversized message
// (kafka-go returns MessageTooLargeError without sending anything) — so one
// such row would otherwise also block the 499 healthy rows sharing its batch.
// Everything else gets an attempt counter and is quarantined once it is clear
// it will not drain.
//
// Quarantined rows are marked, never deleted: an event that could not be
// published is the only remaining copy of something a consumer needed to see.
func (s *Store) DrainUnpublished(
	ctx context.Context, limit int, opts DrainOptions, publish func([]OutboxRow) error,
) (DrainStats, error) {
	var stats DrainStats

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return stats, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT id, topic, kafka_key, payload FROM outbox
		 WHERE published_at IS NULL AND dead_lettered_at IS NULL
		 ORDER BY created_at LIMIT $1
		 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return stats, err
	}
	// Buffer before publishing: a Kafka write while this cursor is open would
	// hit "conn busy" on the same transaction.
	var claimed []OutboxRow
	for rows.Next() {
		var r OutboxRow
		if err := rows.Scan(&r.ID, &r.Topic, &r.Key, &r.Payload); err != nil {
			rows.Close()
			return stats, err
		}
		claimed = append(claimed, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, err
	}
	if len(claimed) == 0 {
		return stats, nil
	}

	// Split before producing. An oversized row is knowable from its length, so
	// it is quarantined here rather than after N round trips that could not
	// have worked — and, decisively, rather than being handed to a producer
	// that would refuse the whole batch because of it.
	batch := claimed[:0:0]
	var oversize []OutboxRow
	for _, r := range claimed {
		if opts.MaxPayloadBytes > 0 && len(r.Payload) > opts.MaxPayloadBytes {
			oversize = append(oversize, r)
			continue
		}
		batch = append(batch, r)
	}

	if len(oversize) > 0 {
		ids := rowIDs(oversize)
		if _, err := tx.Exec(ctx,
			`UPDATE outbox
			    SET dead_lettered_at = now(),
			        publish_error = 'payload ' || octet_length(payload::text) ||
			                        ' bytes exceeds the ' || $2 || ' byte publish limit'
			  WHERE id = ANY($1)`, ids, opts.MaxPayloadBytes); err != nil {
			return stats, err
		}
		stats.DeadLettered = len(oversize)
	}

	if len(batch) == 0 {
		// Nothing sendable, but the quarantine above must persist or the same
		// rows block the queue again on the next tick.
		return stats, tx.Commit(ctx)
	}

	// Produce. Only rows that actually reached Kafka get marked, so a failure
	// here leaves every one of them unpublished for the next tick.
	if perr := publish(batch); perr != nil {
		// Roll back the claim so the locks are released and the rows stay
		// unpublished, then record the attempt SEPARATELY — the counter has to
		// survive a rollback or it can never reach the quarantine threshold.
		_ = tx.Rollback(ctx)
		n, cerr := s.recordPublishFailure(ctx, rowIDs(batch), perr, opts.MaxAttempts)
		stats.DeadLettered += n
		// The publish error is the one worth reading, so it comes first; the
		// bookkeeping error is joined rather than swallowed because losing the
		// attempt counter is what would silently restore retry-forever.
		return stats, errors.Join(perr, cerr)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, rowIDs(batch)); err != nil {
		return stats, err
	}
	// Commit also releases the row locks. If it fails the rows are already on
	// the wire and stay unpublished, so a later tick re-produces them — the
	// same rare at-least-once duplicate the batch semantics above describe.
	if err := tx.Commit(ctx); err != nil {
		return stats, err
	}
	stats.Published = len(batch)
	return stats, nil
}

// recordPublishFailure bumps the attempt counter for a failed batch and
// quarantines any row that has now exhausted it.
//
// Runs in its OWN transaction, deliberately: the caller has just rolled back the
// claim (so the rows are unlocked and still unpublished, which is what preserves
// at-least-once), and a counter written inside that rolled-back transaction
// would be discarded — leaving the row on a permanent retry loop with a
// permanently zero attempt count.
//
// Returns how many rows were quarantined by this call.
func (s *Store) recordPublishFailure(
	ctx context.Context, ids []string, cause error, maxAttempts int,
) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	// Truncated: this lands in a text column that a human reads, and a broker
	// error can carry a very long message.
	reason := cause.Error()
	if len(reason) > 500 {
		reason = reason[:500]
	}

	if maxAttempts <= 0 {
		_, err := s.pool.Exec(ctx,
			`UPDATE outbox SET publish_attempts = publish_attempts + 1, publish_error = $2
			  WHERE id = ANY($1) AND published_at IS NULL`, ids, reason)
		return 0, err
	}

	// ── One UPDATE per row, not two CTEs ─────────────────────────────────────
	// This was a `WITH bumped AS (UPDATE ...), dead AS (UPDATE ... FROM bumped)`
	// pair, and it silently did nothing: Postgres will not modify the same row
	// twice in a single statement, so the second UPDATE matched the rows the
	// first had already touched and skipped every one of them. The counter went
	// up forever and NOTHING was ever quarantined — which is precisely the
	// retry-forever wedge this function exists to end, reintroduced by the fix
	// for it. Verified against Postgres 17: the two-CTE form reports 0.
	//
	// A single UPDATE with a CASE decides both things at once, and RETURNING
	// sees the NEW row, so the count comes back from the same statement. The
	// outer SELECT only READS the CTE, so no row is written twice.
	var quarantined int
	err := s.pool.QueryRow(ctx,
		`WITH bumped AS (
		     UPDATE outbox
		        SET publish_attempts = publish_attempts + 1,
		            publish_error    = $2,
		            dead_lettered_at = CASE
		                WHEN publish_attempts + 1 >= $3 THEN now()
		                ELSE dead_lettered_at
		            END
		      WHERE id = ANY($1) AND published_at IS NULL AND dead_lettered_at IS NULL
		  RETURNING dead_lettered_at
		 )
		 SELECT count(*) FROM bumped WHERE dead_lettered_at IS NOT NULL`,
		ids, reason, maxAttempts).Scan(&quarantined)
	return quarantined, err
}

// DeadLetterCount reports how many rows are currently quarantined, for the
// readiness/metrics surface. A non-zero value means events were accepted from a
// user and will never reach a consumer, which is worth paging on.
func (s *Store) DeadLetterCount(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM outbox WHERE dead_lettered_at IS NOT NULL`).Scan(&n)
	return n, err
}

func rowIDs(rows []OutboxRow) []string {
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}
