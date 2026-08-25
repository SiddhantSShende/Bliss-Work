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
	UserID string `json:"userId"`

	// Task
	AssigneeID string `json:"assigneeId"`

	// Mail
	MailID string `json:"mailId"`
}

// RecipientsOf is the live routing implementation — this is what ws-gateway
// actually runs. It must stay in lockstep with the TS spec/test pair in
// packages/shared/src/types/event-routing-spec.ts (recipientsOf) and
// events.mention.test.ts, which pin the same rules in the schema's own
// language for reviewers who don't read Go. Neither side is generated from
// the other; a routing change must be made in both.
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
	case "channel.message.deleted", "channel.message.reaction",
		"channel.message.pinned":
		// The whole channel, for the same reason message.deleted goes to both
		// DM parties: a moderator's delete that members only learn about on
		// their next refetch is one they may well have screenshotted first, and
		// a pin nobody sees appear is not a pin.
		return dedupe(e.Members)
	case "channel.member.joined":
		// The person who was added, and ONLY them. Deliberately not the roster:
		// this event is emitted once PER ADDED MEMBER, so routing it to
		// everyone would cost added x roster pushes — adding a 500-person
		// department to a 500-person channel would be 250,000. The surviving
		// members' roster is refetched when they next open it, which is what
		// already happened before this event reached a client at all.
		return dedupe([]string{e.UserID})
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
	case "call.scheduled", "call.ring", "call.participant_added", "call.ended",
		"call.started", "call.waiting",
		"call.screenshare_started", "call.screenshare_stopped":
		// Whoever messaging-svc addressed it to, computed server-side.
		//
		// Usually the roster, but not always: call.waiting goes only to the
		// people who could start the call, and nothing here needs to know that
		// — this path delivers to the ids the producer chose, which is exactly
		// why one case can serve events with quite different audiences.
		//
		// This is the one routing case where a recipient may belong to a
		// DIFFERENT ORG than the event: a meeting can be joined by link across
		// orgs, so its roster legitimately spans them. Nothing special is needed
		// here because this path has never filtered by org — it delivers to the
		// user ids the producer computed, and messaging-svc is the component
		// that decided who belongs.
		//
		// Note this is NOT the rtc.* signaling path, which still refuses to
		// forward across an org boundary (see internal/signal). Media now goes
		// to the SFU rather than peer-to-peer, so these are notifications only.
		return dedupe(e.Members)
	case "mail.delivered":
		// Every local recipient plus the author, whose other devices need the
		// Sent copy to appear at the same moment the recipients see the mail.
		return dedupe(e.Members)
	case "mail.outbound":
		// NEVER to a client. This is the instruction to email-worker to put one
		// copy on the wire, and it carries the mail's subject and body in
		// plaintext. The `default` below would already drop it; the case is
		// explicit so that stays true if the default ever changes, and so the
		// reason is written down next to the routing rather than inferred.
		return nil
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
	// Mail carries no messaging messageId, so an ack derived from one has
	// nothing to ack and would 400 at the delivery endpoint.
	"mail.delivered": {},
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
