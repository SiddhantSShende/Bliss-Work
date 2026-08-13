package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// linkChannelWhatsApp is the only deep-link target we support. It is a field
// rather than an implied constant so adding Telegram (t.me) or SMS later is an
// additive change to this list, not a new endpoint.
const linkChannelWhatsApp = "whatsapp"

type forwardLinkReq struct {
	Channel     string `json:"channel"`
	TargetPhone string `json:"targetPhone"`
	TargetName  string `json:"targetName"`
	ClientMsgID string `json:"clientMsgId"`
}

type forwardLinkResp struct {
	Status          string `json:"status"`
	Platform        string `json:"platform"`
	Delivery        string `json:"delivery"`
	TargetPhone     string `json:"targetPhone"`
	SystemMessageID string `json:"systemMessageId"`
}

// forwardLink records a forward the CLIENT is about to perform by opening a
// wa.me deep link, and writes the system entry into the origin chat.
//
// The distinction from forwardExternal (the sibling in forward_external.go) is
// what each is able to promise. That handler sends through integrations-svc and
// records only once the provider accepted, so the original author sees forwards
// that really left — but it needs a connected WhatsApp Business account, which
// most orgs do not have. This handler needs nothing: the message is handed to
// whatever WhatsApp the user already has, and in exchange we lose all visibility
// of the outcome. The forward is therefore recorded as 'unconfirmed', and the
// wording everywhere downstream says "opened WhatsApp to forward", not
// "forwarded".
//
// Nothing is sent from here. The client builds the wa.me URL itself and opens it
// after this returns — it has to open the window synchronously inside the click
// handler or a popup blocker eats it, so it cannot wait on a URL in the response.
func (s *Server) forwardLink(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	var req forwardLinkReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Channel != linkChannelWhatsApp {
		writeErr(w, http.StatusBadRequest, "unsupported channel")
		return
	}
	if !validUUID(req.ClientMsgID) {
		writeErr(w, http.StatusBadRequest, "clientMsgId required")
		return
	}
	phone, err := normalizeE164(req.TargetPhone)
	if err != nil {
		writeErrR(w, r, http.StatusBadRequest,
			"enter the number in full international form, including the country code")
		return
	}
	// The name is optional and is never trusted verbatim: it is rendered in a
	// system entry the other party sees, so it is stripped of anything that
	// could make it look like something other than a contact name.
	name := sanitizeContactName(req.TargetName)

	fc, err := s.store.ForwardLinkResolve(r.Context(), claims.OrgID, claims.UserID, msgID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	res, err := s.store.ForwardLinkRecord(r.Context(), claims.OrgID, claims.UserID, msgID,
		phone, name, req.ClientMsgID, fc)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, forwardLinkResp{
		Status:          "recorded",
		Platform:        linkChannelWhatsApp,
		Delivery:        "unconfirmed",
		TargetPhone:     res.TargetPhone,
		SystemMessageID: res.SystemMessageID,
	})
}
