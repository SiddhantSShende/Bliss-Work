package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// recordMailAttachmentDownload serves
// POST /api/v1/mail/{id}/attachments/{attachmentId}/downloaded.
//
// The client calls it when the reader presses a mail attachment's explicit
// Download — and only then: Preview and Open never do. It records "download
// initiated" in the admin-facing activity timeline and does nothing else (see
// store.RecordMailAttachmentDownload). The acting user is the verified JWT's,
// never anything in the request; there is no body.
func (s *Server) recordMailAttachmentDownload(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	attachmentID := chi.URLParam(r, "attachmentId")
	if !validUUID(mailID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid mail id")
		return
	}
	if !validUUID(attachmentID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid attachment id")
		return
	}
	if err := s.store.RecordMailAttachmentDownload(r.Context(), claims.OrgID, claims.UserID, mailID, attachmentID); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
