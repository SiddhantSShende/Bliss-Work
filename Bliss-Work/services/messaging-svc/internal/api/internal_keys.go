package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// rotateOrgDEKResp mirrors auth-svc's POST /internal/keys/rotate/{org_id}
// response shape, so an ops tool that rotates a org across services sees the
// same contract from both.
type rotateOrgDEKResp struct {
	OrgID      string `json:"orgId"`
	OldVersion int    `json:"oldVersion"`
	NewVersion int    `json:"newVersion"`
}

// rotateOrgDEK rotates an org's Data Encryption Key (messagingdb's org_keys).
// New writes use the new generation; existing ciphertext stays readable via
// its embedded key_version (crypto.Cryptor.RotateDEK is lazy). Repeat per
// service database to fully rotate an org — see auth-svc's twin endpoint.
//
// Auth: shared X-Internal-Token, same as markDelivered. Ops / incident-
// response tooling only; never called from the public API.
func (s *Server) rotateOrgDEK(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	orgID := chi.URLParam(r, "orgId")
	if !validUUID(orgID) {
		writeErr(w, http.StatusBadRequest, "invalid org id")
		return
	}
	oldVersion, newVersion, err := s.store.RotateOrgDEK(r.Context(), orgID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rotateOrgDEKResp{
		OrgID:      orgID,
		OldVersion: oldVersion,
		NewVersion: newVersion,
	})
}
