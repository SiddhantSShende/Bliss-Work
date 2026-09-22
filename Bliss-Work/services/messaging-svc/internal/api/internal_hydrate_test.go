package api

import (
	"encoding/json"
	"testing"
)

// ws-gateway rebuilds a client-facing message.created from this response BY FIELD
// NAME, and the client drops any frame missing orgId or clientMsgId (its schema
// requires both). So the tags are a cross-service contract: renaming one, or
// adding omitempty, silently makes every replayed chat message disappear.
func TestHydrateMessageResp_CarriesOrgAndClientMsgIDEvenWhenEmpty(t *testing.T) {
	raw, err := json.Marshal(hydrateMessageResp{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"orgId", "clientMsgId", "messageId", "conversationId", "seq", "senderId", "recipientId", "body", "occurredAt"} {
		if _, ok := got[key]; !ok {
			t.Errorf("response has no %q field: ws-gateway rebuilds the client frame from it", key)
		}
	}
}
