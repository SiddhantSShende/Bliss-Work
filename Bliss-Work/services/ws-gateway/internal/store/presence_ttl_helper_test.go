package store

import "context"

// touch is the one place the tests name TouchPresence's signature.
func touch(st *Store, orgID, userID, connID string, beat uint64) error {
	return st.TouchPresence(context.Background(), orgID, userID, "node-1", connID, beat)
}
