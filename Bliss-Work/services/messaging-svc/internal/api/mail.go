package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
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
