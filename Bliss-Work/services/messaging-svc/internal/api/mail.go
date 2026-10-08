package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// createMailDraft serves POST /api/v1/mail/drafts.
//
// Opens an empty draft so the composer has somewhere to hang attachments (see
// store.CreateMailDraft). Returns the id the composer then uses as the
// attachment scopeId and as the target of /send.
func (s *Server) createMailDraft(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID, err := s.store.CreateMailDraft(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"mailId": mailID})
}

// discardMailDraft serves DELETE /api/v1/mail/drafts/{id} — the composer was
// closed without sending. Idempotent from the client's point of view: a draft
// that is already gone is not an error worth surfacing on a cancel.
func (s *Server) discardMailDraft(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	if !validUUID(mailID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid mail id")
		return
	}
	if err := s.store.DiscardMailDraft(r.Context(), claims.OrgID, claims.UserID, mailID); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listMailDrafts serves GET /api/v1/mail/drafts — the Drafts folder.
//
// Not part of GET /inbox, which is where every other mailbox listing comes
// from, because a draft is not in anybody's feed: it has no counterparty, no
// unread state and no delivery, and projecting one into inbox_items would put
// it in the People sidebar's rollups and in the unread badge. See
// store.MailDraftDTO.
func (s *Server) listMailDrafts(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	drafts, err := s.store.ListMailDrafts(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, drafts)
}

// saveMailDraftReq is the composer's current contents. Same field names as
// sendMailReq: it is the same form, saved rather than sent.
type saveMailDraftReq struct {
	To       []string `json:"to"`
	Cc       []string `json:"cc"`
	Bcc      []string `json:"bcc"`
	Subject  string   `json:"subject"`
	BodyText string   `json:"bodyText"`
}

// saveMailDraft serves PATCH /api/v1/mail/drafts/{id} — the composer's autosave.
//
// Not behind the idempotency middleware, unlike send: a save is a full
// overwrite of one row the caller owns, so replaying it is what it already does.
func (s *Server) saveMailDraft(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	if !validUUID(mailID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid mail id")
		return
	}
	var req saveMailDraftReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrR(w, r, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.store.SaveMailDraft(r.Context(), store.SaveMailDraftInput{
		OrgID:    claims.OrgID,
		UserID:   claims.UserID,
		MailID:   mailID,
		To:       req.To,
		Cc:       req.Cc,
		Bcc:      req.Bcc,
		Subject:  req.Subject,
		BodyText: req.BodyText,
		// Files already uploaded to this draft get their expiry pushed out, so
		// a draft still being edited keeps them. See SaveMailDraftInput.
		AttachmentTTL: s.mediaCfg.UploadTTL,
	}); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeDraftAttachment serves
// DELETE /api/v1/mail/drafts/{id}/attachments/{attachmentId}.
//
// Taking a file back off a draft the author is still writing. There is no
// general "delete an attachment" endpoint and this is not one: it reaches only
// files on the caller's own UNSENT mail, where nobody else can have seen them.
//
// The blob is unlinked after the row is gone and only when nothing in the org
// still points at those bytes — the same order and the same condition the
// attachment reaper uses.
func (s *Server) removeDraftAttachment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	attachmentID := chi.URLParam(r, "attachmentId")
	if !validUUID(mailID) || !validUUID(attachmentID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid id")
		return
	}
	// The store calls this under the per-blob lock, once it has seen that no row
	// in the org points at the bytes any more.
	unlink := func(sha string) {
		if rerr := s.blobs.Remove(claims.OrgID, sha); rerr != nil {
			// The row is already gone, so the file is unreachable either way and
			// the user's request succeeded. Logged rather than surfaced: what is
			// left behind is disk, and re-uploading the same content will simply
			// dedupe onto it.
			s.log.Error("draft attachment blob unlink failed", "mail_id", mailID,
				"attachment_id", attachmentID, "err", rerr,
				"request_id", mw.RequestIDFromContext(r.Context()))
		}
	}
	if _, err := s.store.RemoveDraftAttachment(
		r.Context(), claims.OrgID, claims.UserID, mailID, attachmentID, unlink); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sendMailReq is the composed mail. Addresses arrive as typed; the store
// normalizes and validates each one and reports which address was rejected.
type sendMailReq struct {
	To       []string `json:"to"`
	Cc       []string `json:"cc"`
	Bcc      []string `json:"bcc"`
	Subject  string   `json:"subject"`
	BodyText string   `json:"bodyText"`
}

// sendMail serves POST /api/v1/mail/drafts/{id}/send.
//
// Sits behind the idempotency middleware: Send is the one action here with no
// natural client-supplied id, and a double-tap on a slow connection must not
// fan a mail out twice.
func (s *Server) sendMail(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	if !validUUID(mailID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid mail id")
		return
	}
	var req sendMailReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrR(w, r, http.StatusBadRequest, "invalid body")
		return
	}
	res, err := s.store.SendMail(r.Context(), store.SendMailInput{
		OrgID:    claims.OrgID,
		UserID:   claims.UserID,
		MailID:   mailID,
		To:       req.To,
		Cc:       req.Cc,
		Bcc:      req.Bcc,
		Subject:  req.Subject,
		BodyText: req.BodyText,
	})
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// getMail serves GET /api/v1/mail/{id} — the full email behind an Inbox row.
func (s *Server) getMail(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	if !validUUID(mailID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid mail id")
		return
	}
	m, err := s.store.GetMail(r.Context(), claims.OrgID, claims.UserID, mailID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// markMailRead serves POST /api/v1/mail/{id}/read.
func (s *Server) markMailRead(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	mailID := chi.URLParam(r, "id")
	if !validUUID(mailID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid mail id")
		return
	}
	if err := s.store.MarkMailRead(r.Context(), claims.OrgID, claims.UserID, mailID); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// inboundMailReq is what the MTA-side ingestion posts. See
// store.InboundMailInput for why this contract is parsed rather than raw MIME.
type inboundMailReq struct {
	OrgID             string   `json:"orgId"`
	ExternalMessageID string   `json:"externalMessageId"`
	FromAddress       string   `json:"fromAddress"`
	FromName          string   `json:"fromName"`
	Subject           string   `json:"subject"`
	BodyText          string   `json:"bodyText"`
	BodyHTML          string   `json:"bodyHtml"`
	To                []string `json:"to"`
	Cc                []string `json:"cc"`
	SentAt            string   `json:"sentAt"`
}

// receiveInboundMail serves POST /internal/mail/inbound.
//
// Auth: the shared X-Internal-Token, same as the delivery-ack endpoint. NOT
// under /api/v1, so no JWT middleware and no CORS — this is reachable only from
// inside the deployment network by whatever terminates SMTP.
//
// A duplicate Message-ID answers 200 rather than an error: webhooks retry on
// anything that is not a success, and the correct outcome of a retry is "yes,
// I already have that one" — answering 409 would make the sender keep trying.
func (s *Server) receiveInboundMail(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErrR(w, r, http.StatusUnauthorized, "bad internal token")
		return
	}
	var req inboundMailReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrR(w, r, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.OrgID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid orgId")
		return
	}
	var sentAt time.Time
	if req.SentAt != "" {
		parsed, err := time.Parse(time.RFC3339, req.SentAt)
		if err != nil {
			writeErrR(w, r, http.StatusBadRequest, "sentAt must be RFC3339")
			return
		}
		sentAt = parsed.UTC()
	}
	mailID, delivered, err := s.store.DeliverInboundMail(r.Context(), store.InboundMailInput{
		OrgID:             req.OrgID,
		ExternalMessageID: req.ExternalMessageID,
		FromAddress:       req.FromAddress,
		FromName:          req.FromName,
		Subject:           req.Subject,
		BodyText:          req.BodyText,
		BodyHTML:          req.BodyHTML,
		To:                req.To,
		Cc:                req.Cc,
		SentAt:            sentAt,
	})
	if errors.Is(err, store.ErrMailDuplicate) {
		writeJSON(w, http.StatusOK, map[string]any{"duplicate": true})
		return
	}
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"mailId": mailID, "delivered": delivered})
}

// internalMailAttachment serves GET /internal/mail/{mailId}/attachments/{id}.
//
// This is where the SMTP relay gets the bytes of a file someone attached. The
// bytes live on a volume mounted into THIS service only, so email-worker asks
// for them rather than reading another service's disk — the same boundary that
// makes it ask auth-svc for a member's address instead of reading authdb.
//
// Auth: the shared X-Internal-Token, as with the two endpoints above, plus
// GetSentMailAttachment's own check that the file really is on that mail and
// that the mail has been sent. Reachable only from inside the deployment
// network; it must not be published through Caddy.
//
// Always Content-Disposition: attachment and nosniff. Nothing here is ever
// rendered — the one caller is a program building a MIME part — and serving a
// user-supplied file inline on this origin is the XSS foot-gun downloadMedia
// documents at length. Same reason the declared MIME is echoed rather than
// trusted for display.
func (s *Server) internalMailAttachment(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErrR(w, r, http.StatusUnauthorized, "bad internal token")
		return
	}
	orgID := r.URL.Query().Get("orgId")
	if !validUUID(orgID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid orgId")
		return
	}
	att, err := s.store.GetSentMailAttachment(
		r.Context(), orgID, chi.URLParam(r, "mailId"), chi.URLParam(r, "id"))
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	f, err := s.blobs.Open(orgID, att.SHA256)
	if err != nil {
		// The row outlived its bytes. Logged rather than retried: the relay
		// treats this as "cannot attach" and still sends the mail, which is the
		// right outcome — the message matters more than the file.
		s.log.Error("mail attachment blob missing", "mail_id", chi.URLParam(r, "mailId"),
			"attachment_id", chi.URLParam(r, "id"), "sha256", att.SHA256,
			"request_id", mw.RequestIDFromContext(r.Context()))
		writeErrR(w, r, http.StatusNotFound, "file not found")
		return
	}
	defer f.Close()

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	h.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", f.ModTime(), f)
}
