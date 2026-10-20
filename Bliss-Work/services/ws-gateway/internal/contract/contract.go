package contract

// Topics consumed by the gateway for fan-out. auth.events carries mostly
// internal-only event types (password resets, invites, session lifecycle —
// see the `default` case in RecipientsOf, which drops every one of them
// before a client ever sees this topic was added); the one exception is
// user.theme_prefs_changed, routed below like any other single-user event.
var FanoutTopics = []string{
	"messaging.events.v1",
	"task.events.v1",
	"notification.events.v1",
	"integration.events.v1",
	"auth.events",
}

// Event is the partially-parsed envelope used for routing. Only the fields the
// gateway needs to compute recipients and the replay score are extracted; the
// raw JSON bytes are forwarded verbatim to clients.
type Event struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
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
	// message.forwarded only — see that case in RecipientsOf.
	ForwardedBy  string `json:"forwardedBy"`
	RootAuthorID string `json:"rootAuthorId"`
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
// actually runs. It must stay in lockstep with the TS spec in
// packages/shared/src/types/event-routing-spec.ts (recipientsOf), which pins
// the same rules in the schema's own language for reviewers who don't read
// Go. Neither side is generated from the other; a routing change must be
// made in both.
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
	case "message.forwarded":
		// The forwarder (multi-device sync) and the ORIGINAL author, who is
		// the person entitled to know their message left the workspace.
		// Deliberately NOT Members: for a channel source that would publish a
		// third party's name to the whole roster, and the pill written into
		// the chat already tells the room as much as it should know. Mirrors
		// event-routing-spec.ts's MessageForwarded case exactly — this was
		// missing here entirely (fell through to the zero-recipient default,
		// which drops the event from both live delivery and the replay
		// outbox) even though messaging-svc actively produces it.
		return dedupe([]string{e.ForwardedBy, e.RootAuthorID})
	case "task.assigned":
		if len(e.Members) > 0 {
			return dedupe(e.Members)
		}
		return dedupe([]string{e.SenderID, e.AssigneeID})
	case "sticky.refresh":
		// The desktop-note delivery watchdog (services/sticky-relay) telling one
		// person's clients to re-fetch their pins. Carries no task content, so
		// there is nobody else to deliver it to.
		return dedupe([]string{e.AssigneeID})
	case "sticky.pin.changed":
		// sticky-svc: this user pinned or unpinned one of their own tasks.
		// AssigneeID is that user. It goes to them alone — every device they
		// own (Web and Desktop), and never to the task's sender or other
		// assignees: a pin is private to the person who made it.
		return dedupe([]string{e.AssigneeID})
	case "task.acknowledged", "task.completed", "task.ignored", "task.left", "task.missed", "task.withdrawn", "task.reviewed":
		if e.Type == "task.withdrawn" && len(e.Members) > 0 {
			return dedupe(e.Members)
		}
		return dedupe([]string{e.SenderID, e.AssigneeID})
	case "task.comment_created":
		// task-svc always sets Members to the full current recipient set
		// (sender + every assignee) — there is no single sender/assignee pair
		// to fall back to here, unlike task.assigned.
		return dedupe(e.Members)
	case "notification.created", "notification.read":
		return dedupe([]string{e.RecipientID})
	case "integration.activity.created":
		// integrations-svc's emit_activity_created addresses this to exactly
		// one user (the connection's owner, or its created_by for an outbound
		// send) — see services/integrations-svc/app/events.py. This topic was
		// added to FanoutTopics in the same change as this case: before, the
		// event published successfully (the topic itself was missing from the
		// broker, now fixed in infra/kafka/create-topics.sh) but ws-gateway
		// never subscribed to it at all, so it reached no client regardless of
		// routing.
		return dedupe([]string{e.RecipientID})
	case "call.scheduled", "call.ring", "call.participant_added", "call.ended",
		"call.started", "call.waiting", "call.participant_left",
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
	case "user.theme_prefs_changed":
		// auth-svc: this user's theme document changed on one device. Delivered
		// to them alone — every device/session they have open, same pattern as
		// sticky.pin.changed — so the others can re-pull GET /auth/me right away
		// instead of waiting on their own focus/visibility poll.
		return dedupe([]string{e.UserID})
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
