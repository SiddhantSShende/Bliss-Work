package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// deferredOrgQuerier lets crypto.Decrypt be called AFTER a read's own
// transaction has already released its connection, instead of holding that
// connection for the whole per-row decrypt loop.
//
// crypto.Decrypt only touches Postgres at all on a DEK cache miss (see
// Cryptor.dekForVersion) — the overwhelmingly common case is a cache hit,
// pure CPU, zero queries. A read like ListInbox used to decrypt its whole
// page inside the SAME transaction as its SELECT, which cost nothing extra
// on a cache hit but still meant the pool connection sat idle-but-checked-out
// for the full duration of every row's AES-GCM decrypt — under a bounded
// pool, that is strictly worse than releasing the connection the moment the
// SELECT's rows are drained and only reaching for a connection again on the
// rare cache miss.
//
// org_keys carries FORCE ROW LEVEL SECURITY like every other org table
// (0007_rls.sql) — messaging_user has no BYPASSRLS, so a query against it
// with no app.org_id set matches zero rows and Decrypt would wrongly report
// "no DEK for org ... (crypto-shredded?)" for a perfectly live org. Passing
// the raw pool here instead of this type would be that bug. Each on-demand
// query below therefore opens its own short, properly org-scoped
// transaction — exactly what withOrg already does for everything else — so
// the rare cache-miss path stays exactly as safe as it always was.
type deferredOrgQuerier struct {
	store *Store
	orgID string
}

func (q deferredOrgQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return &deferredRow{ctx: ctx, store: q.store, orgID: q.orgID, sql: sql, args: args}
}

// Exec exists only to satisfy crypto.Querier (Encrypt's DEK-creation path
// uses it); Decrypt never calls it, and decrypt is the only thing this
// deferred querier is used for.
func (q deferredOrgQuerier) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	var tag pgconn.CommandTag
	err := q.store.withOrg(ctx, q.orgID, func(tx pgx.Tx) error {
		t, err := tx.Exec(ctx, sql, args...)
		tag = t
		return err
	})
	return tag, err
}

// deferredRow defers running the query until Scan is actually called, at
// which point it opens one short org-scoped transaction, runs it, and scans
// into dest before releasing the connection.
type deferredRow struct {
	ctx   context.Context
	store *Store
	orgID string
	sql   string
	args  []any
}

func (r *deferredRow) Scan(dest ...any) error {
	var scanErr error
	txErr := r.store.withOrg(r.ctx, r.orgID, func(tx pgx.Tx) error {
		scanErr = tx.QueryRow(r.ctx, r.sql, r.args...).Scan(dest...)
		return nil
	})
	if txErr != nil {
		return txErr
	}
	return scanErr
}
