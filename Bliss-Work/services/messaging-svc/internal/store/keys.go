// keys.go: org_keys administration (DEK rotation and first-key creation).
// Everything else about column encryption lives in internal/crypto — this is
// just the store-side wrapper that gives crypto.Cryptor the tx + app.org_id it
// needs.
package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/crypto"
)

// firstKeyCloseTimeout bounds closing the one-off connection; the request's own
// context may already be cancelled by then.
const firstKeyCloseTimeout = 5 * time.Second

// newFirstKeyCommitter returns the crypto.KeyCommitter that creates an org's
// first DEK in its own committed transaction (see crypto.KeyCommitter for why).
//
// It dials a connection of its own instead of borrowing from the pool. The
// caller is mid-transaction and already holds one pool connection; borrowing a
// second would let a burst of first writes for distinct new orgs each hold one
// while waiting for another, and wedge the pool. This runs once per org, ever,
// so the cost of a dedicated connection is negligible.
func newFirstKeyCommitter(connCfg *pgx.ConnConfig) crypto.KeyCommitter {
	return func(ctx context.Context, orgID string, fn func(crypto.Querier) error) error {
		conn, err := pgx.ConnectConfig(ctx, connCfg.Copy())
		if err != nil {
			return err
		}
		defer func() {
			closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), firstKeyCloseTimeout)
			defer cancel()
			_ = conn.Close(closeCtx) // nothing left to do if closing a finished connection fails
		}()

		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if err := fn(tx); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
}

// RotateOrgDEK rotates orgID's Data Encryption Key. New writes use the new
// generation immediately; existing ciphertext keeps decrypting via its
// embedded key_version (rotation is lazy — see crypto.Cryptor.RotateDEK).
// Returns (oldVersion, newVersion).
func (s *Store) RotateOrgDEK(ctx context.Context, orgID string) (oldVersion, newVersion int, err error) {
	err = s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var rerr error
		oldVersion, newVersion, rerr = s.crypto.RotateDEK(ctx, tx, orgID)
		return rerr
	})
	return oldVersion, newVersion, err
}
