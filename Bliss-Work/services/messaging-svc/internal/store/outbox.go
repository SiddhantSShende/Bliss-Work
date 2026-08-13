package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
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

// ── Projection upsert (consumer) ───────────────────────────────────────────────

// UpsertUser stores/updates a user_projection row (from auth user.created).
//
// RLS: this runs in the AuthConsumer — a cross-org BACKGROUND Kafka consumer
// (it projects user.created for every org off one stream). user_projection is
// RLS-protected, so it runs under BYPASS. (The orgID arg is the row's org, not
// a request-scoped caller org, so it is NOT used to scope app.org_id.)
func (s *Store) UpsertUser(ctx context.Context, userID, orgID, username, displayName string) error {
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (user_id) DO UPDATE
			 SET org_id = EXCLUDED.org_id, username = EXCLUDED.username, display_name = EXCLUDED.display_name`,
			userID, orgID, username, displayName)
		return err
	})
}

// SetUserActive flips user_projection.active for a membership lifecycle event
// (user.deactivated / user.reactivated / user.removed).
//
// The row is never deleted: messages, channel memberships and forward chains
// all reference user_id, and their sender names are resolved through this
// projection — dropping the row would blank the history a departed member left
// behind. Same cross-org BYPASS reasoning as UpsertUser above.
func (s *Store) SetUserActive(ctx context.Context, userID string, active bool) error {
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE user_projection SET active = $2 WHERE user_id = $1`,
			userID, active)
		return err
	})
}

// ── Consumer dedup ──────────────────────────────────────────────────────────────

// MarkConsumed records an event_id; returns false if it was already processed.
func (s *Store) MarkConsumed(ctx context.Context, eventID string) (bool, error) {
	ct, err := s.pool.Exec(ctx,
		`INSERT INTO consumed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}

// MarkConsumedInboxTasks dedups events in the *task projector* consumer group,
// kept separate from the auth-projection dedup so two groups consuming
// overlapping eventIds don't collide on the per-event_id PK.
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

// FetchUnpublished returns up to limit unpublished outbox rows in insertion order.
func (s *Store) FetchUnpublished(ctx context.Context, limit int) ([]OutboxRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, topic, kafka_key, payload FROM outbox
		 WHERE published_at IS NULL ORDER BY created_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []OutboxRow
	for rows.Next() {
		var r OutboxRow
		if err := rows.Scan(&r.ID, &r.Topic, &r.Key, &r.Payload); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkPublished stamps published_at on the given outbox row.
func (s *Store) MarkPublished(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE outbox SET published_at = now() WHERE id = $1`, id)
	return err
}
