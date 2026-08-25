// keys.go: org_keys administration (DEK rotation). Everything else about
// column encryption lives in internal/crypto — this is just the store-side
// wrapper that gives crypto.Cryptor.RotateDEK the tx + app.org_id it needs.
package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

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
