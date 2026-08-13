package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	mw "github.com/task-board/messaging-svc/internal/middleware"
)

// integrationsInternalBase is the private base URL of integrations-svc, used for
// the outbound-to-external send. Not exposed to clients.
var integrationsInternalBase = func() string {
	if v := os.Getenv("INTEGRATIONS_INTERNAL_BASE"); v != "" {
		return v
	}
	return "http://integrations-svc:8005"
}()

// allowedExternalPlatforms mirrors the message_forwards.platform CHECK (minus the
// internal 'blisswork'), so a bogus provider from the integrations response can't
// violate the constraint.
var allowedExternalPlatforms = map[string]struct{}{
	"whatsapp": {}, "slack": {}, "teams": {}, "gmail": {}, "outlook": {},
}

type extSendResp struct {
	Status     string `json:"status"`
	ExternalID string `json:"externalId"`
	Provider   string `json:"provider"`
}

// sendViaIntegrations asks integrations-svc to deliver text through a connected
// external account (shared-secret authenticated, same TB_INTERNAL_TOKEN pattern).
func sendViaIntegrations(ctx context.Context, orgID, connectionID, target, text string) (extSendResp, error) {
	payload, _ := json.Marshal(map[string]string{
		"orgId": orgID, "connectionId": connectionID, "target": target, "text": text,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		integrationsInternalBase+"/internal/messages/send", bytes.NewReader(payload))
	if err != nil {
		return extSendResp{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", internalToken)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return extSendResp{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return extSendResp{}, fmt.Errorf("integrations send failed: %d", resp.StatusCode)
	}
	var out extSendResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return extSendResp{}, err
	}
	return out, nil
}

type forwardExternalReq struct {
	ConnectionID string `json:"connectionId"`
	Target       string `json:"target"`
	ClientMsgID  string `json:"clientMsgId"`
}

// forwardExternal forwards message {id} OUT to a contact on a connected external
// platform. It resolves provenance, sends via integrations-svc, then records the
// forward edge + emits message.forwarded (so the ORIGINAL author is notified).
func (s *Server) forwardExternal(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	var req forwardExternalReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.ConnectionID) || req.Target == "" {
		writeErr(w, http.StatusBadRequest, "connectionId and target are required")
		return
	}

	fc, err := s.store.ForwardExternalResolve(r.Context(), claims.OrgID, claims.UserID, msgID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}

	res, err := sendViaIntegrations(r.Context(), claims.OrgID, req.ConnectionID, req.Target, fc.Body)
	if err != nil {
		s.log.Warn("external forward send failed", "err", err, "request_id", mw.RequestIDFromContext(r.Context()))
		writeErrR(w, r, http.StatusBadGateway, "couldn't send via the connected account")
		return
	}
	platform := res.Provider
	if _, ok := allowedExternalPlatforms[platform]; !ok {
		writeErrR(w, r, http.StatusBadGateway, "connected account returned an unknown platform")
		return
	}

	if err := s.store.ForwardExternalRecord(r.Context(), claims.OrgID, claims.UserID, msgID, req.Target, platform, fc); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"status": "sent", "externalId": res.ExternalID, "platform": platform,
	})
}
