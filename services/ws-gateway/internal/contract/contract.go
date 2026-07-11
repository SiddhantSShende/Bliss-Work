package contract

// Topics consumed by the gateway for fan-out (excludes auth.events, which is
// internal-only and never pushed to a client socket).
var FanoutTopics = []string{
	"messaging.events.v1",
	"task.events.v1",
	"notification.events.v1",
}

// Event is the partially-parsed envelope used for routing. Only the fields the
// gateway needs to compute recipients and the replay score are extracted; the
// raw JSON bytes are forwarded verbatim to clients.
type Event struct {
	Type       string `json:"type"`
	OccurredAt string `json:"occurredAt"`

	// Messaging
	ConversationID  string   `json:"conversationId"`
	ChannelID       string   `json:"channelId"`
	RecipientID     string   `json:"recipientId"`
	SenderID        string   `json:"senderId"`
	Members         []string `json:"members"`
	MessageID       string   `json:"messageId"`
	ThreadID        string   `json:"threadId"`
	ParentMessageID string   `json:"parentMessageId"`
	DismissedBy     string   `json:"dismissedBy"`

	// Task
	AssigneeID string `json:"assigneeId"`
}

// RecipientsOf replicates the canonical recipientsOf() routing function from
// packages/shared/src/types/events.ts.
func (e *Event) RecipientsOf() []string {
	switch e.Type {
	case "message.created":
		return dedupe([]string{e.RecipientID, e.SenderID})
	case "conversation.ignored":
		return dedupe(e.Members)
	case "conversation.blocked", "conversation.unblocked":
		// Both members: the blocked peer flips their composer banner live and
		// the blocker's other devices stay in sync.
		return dedupe(e.Members)
	case "channel.message.created":
		return dedupe(e.Members)
	case "message.read":
		return dedupe([]string{e.RecipientID})
	case "message.delivered":
		// Sender-only echo so the per-message Delivered badge flips.
		return dedupe([]string{e.SenderID})
	case "message.dismissed":
		// Multi-device sync for the sender who dismissed.
		return dedupe([]string{e.DismissedBy})
	case "task.assigned":
		return dedupe([]string{e.AssigneeID})
	case "task.acknowledged", "task.completed", "task.ignored", "task.left", "task.reviewed":
		return dedupe([]string{e.SenderID, e.AssigneeID})
	case "notification.created":
		return dedupe([]string{e.RecipientID})
	default:
		// user.created / invite.created and anything unknown are internal-only.
		return nil
	}
}

// NoDeliveryAckFor mirrors NO_DELIVERY_ACK_FOR in events.ts. Phase 5's
// gateway conn handler MUST NOT forward a message.ack derived from these
// event types — otherwise the delivered → ack → delivered fan-in cycles.
var NoDeliveryAckFor = map[string]struct{}{
	"message.delivered":      {},
	"message.read":           {},
	"message.dismissed":      {},
	"conversation.ignored":   {},
	"conversation.blocked":   {},
	"conversation.unblocked": {},
	"task.acknowledged":      {},
	"task.completed":         {},
	"task.ignored":           {},
	"task.left":              {},
	"task.reviewed":          {},
	"notification.created":   {},
}

func dedupe(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
