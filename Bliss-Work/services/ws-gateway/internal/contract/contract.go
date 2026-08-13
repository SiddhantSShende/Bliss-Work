package contract

// Topics consumed by the gateway for fan-out (excludes auth.events, which is
// internal-only and never pushed to a client socket).
var FanoutTopics = []string{
	"messaging.events.v1",
	"task.events.v1",
	"notification.events.v1",
	"integration.events.v1",
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
	// The person a channel moderation event was ABOUT. They are usually no
	// longer in `Members` — that is precisely why it has to be carried
	// separately, or the removed member never learns they were removed.
	UserID          string   `json:"userId"`

	// Forward tracking
	ForwardedBy  string `json:"forwardedBy"`
	ForwardedTo  string `json:"forwardedTo"`
	RootAuthorID string `json:"rootAuthorId"`

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
	case "channel.member.removed", "channel.member.role_changed",
		"channel.blocked", "channel.unblocked":
		// Surviving members refresh the roster; the affected user is appended
		// because they are no longer in it and would otherwise sit looking at a
		// channel they can no longer post to. dedupe drops the empty entry if a
		// producer ever omits userId.
		return dedupe(append(append([]string{}, e.Members...), e.UserID))
	case "message.read":
		return dedupe([]string{e.RecipientID})
	case "message.delivered":
		// Sender-only echo so the per-message Delivered badge flips.
		return dedupe([]string{e.SenderID})
	case "message.dismissed":
		// Multi-device sync for the sender who dismissed.
		return dedupe([]string{e.DismissedBy})
	case "message.deleted", "message.reaction":
		// BOTH parties, unlike message.dismissed. A delete-for-everyone that
		// the recipient only learned about at their next refetch is one they
		// may well have screenshotted first; a reaction nobody sees arrive is
		// not a reaction.
		return dedupe(e.Members)
	case "message.forwarded":
		// C receives the forward (internal only), B's other devices sync, and —
		// the whole point — the ORIGINAL author learns B→C. ForwardedTo is empty
		// for outbound-to-external forwards; dedupe drops the empty entry.
		return dedupe([]string{e.ForwardedTo, e.ForwardedBy, e.RootAuthorID})
	case "task.assigned":
		return dedupe([]string{e.AssigneeID})
	case "task.acknowledged", "task.completed", "task.ignored", "task.left", "task.reviewed":
		return dedupe([]string{e.SenderID, e.AssigneeID})
	case "notification.created":
		return dedupe([]string{e.RecipientID})
	case "integration.activity.created":
		// Live hub push to the account owner/connector.
		return dedupe([]string{e.RecipientID})
	case "integration.mention.created":
		// The mentioned user only — the connection owner already got the
		// activity event, and a mention is personal to whoever was tagged.
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
	"message.deleted":        {},
	"message.reaction":       {},
	"message.forwarded":      {},
	"conversation.ignored":   {},
	"conversation.blocked":   {},
	"conversation.unblocked": {},
	"task.acknowledged":      {},
	"task.completed":         {},
	"task.ignored":           {},
	"task.left":              {},
	"task.reviewed":          {},
	"notification.created":   {},
	// Integration events carry no messaging messageId, so a delivery ack
	// derived from one has nothing to ack and would 400 downstream.
	"integration.activity.created": {},
	"integration.mention.created":  {},
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
