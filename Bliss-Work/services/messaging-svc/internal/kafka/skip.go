package kafka

import (
	"errors"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/task-board/messaging-svc/internal/metrics"
)

// This service has no dead-letter topic for its consumers, so an event that can
// never be applied is skipped LOUDLY instead: an ERROR log naming it and a
// counter (messaging_consumer_events_skipped_total) that any alert can watch.
// Skipping is reserved for events that no retry can cure; everything else is
// retried without limit by handleWithRetry.

// skipMalformed records an event skipped because its payload can never be
// applied (unparseable JSON, a missing or invalid id). It always reports true —
// "commit this offset" — so call sites read `return skipMalformed(...)`.
func skipMalformed(log *slog.Logger, consumer, msg string, args ...any) bool {
	log.Error(msg, args...)
	metrics.ConsumerEventsSkippedTotal.WithLabelValues(consumer, "malformed").Inc()
	return true
}

// skipIfPermanent decides what a failed store call means. For an error that is
// about the event's own data and so can never succeed on a retry it logs,
// counts and reports true (commit: skip the event). For anything else — the
// database or a dependency being unavailable, a conflict, a timeout — it logs
// and reports false, which makes handleWithRetry retry without limit and
// without committing.
func skipIfPermanent(log *slog.Logger, consumer, msg string, err error, args ...any) bool {
	args = append(args, "err", err)
	if isPermanentDBError(err) {
		log.Error(msg+" (permanent database error; event skipped, will never succeed)", args...)
		metrics.ConsumerEventsSkippedTotal.WithLabelValues(consumer, "permanent_db").Inc()
		return true
	}
	log.Error(msg, args...)
	return false
}

// isPermanentDBError reports a Postgres error that is about the event's own
// data, so redelivering the same event can never cure it: class 22 (data
// exception — 22P02 a malformed uuid, 22021 an unstorable character, 22001 a
// value too long) and the constraint violations 23502 (not null), 23503
// (foreign key) and 23514 (check). Connection loss, timeouts, 40001/40P01
// conflicts, resource and shutdown errors (53xxx/57xxx), a missing table
// (42P01 — a deploy fixes that) and 23505 (a unique violation can be a
// concurrent-writer race) are all transient.
func isPermanentDBError(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	if strings.HasPrefix(pgErr.Code, "22") {
		return true
	}
	switch pgErr.Code {
	case "23502", "23503", "23514":
		return true
	}
	return false
}
