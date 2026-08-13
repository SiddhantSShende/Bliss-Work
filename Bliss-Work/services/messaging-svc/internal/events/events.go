// Package events defines the canonical Kafka event envelopes and payloads.
// Field names (camelCase) MUST match the canonical TS contract exactly.
package events

// Topics and their message keys.
const (
	TopicMessaging = "messaging.events.v1" // key = conversationId
	TopicTask      = "task.events.v1"      // key = taskId
	TopicNotif     = "notification.events.v1"
	TopicAuth      = "auth.events" // key = userId
)

// Event type discriminants. Strings must match packages/shared/src/types/events.ts.
const (
	TypeMessageCreated        = "message.created"
	TypeConversationIgnored   = "conversation.ignored"
	TypeMessageRead           = "message.read"
	TypeMessageDelivered      = "message.delivered"
	TypeMessageDismissed      = "message.dismissed"
	TypeMessageDeleted        = "message.deleted"
	TypeMessageReaction       = "message.reaction"
	TypeMessageForwarded      = "message.forwarded"
	TypeUserCreated           = "user.created"
	TypeUserDeactivated       = "user.deactivated"
	TypeUserReactivated       = "user.reactivated"
	TypeUserRemoved           = "user.removed"
	TypeChannelMessageCreated = "channel.message.created"
	TypeChannelMemberJoined   = "channel.member.joined"
	TypeChannelMemberRemoved  = "channel.member.removed"
	TypeChannelRoleChanged    = "channel.member.role_changed"
	TypeChannelBlocked        = "channel.blocked"
	TypeChannelUnblocked      = "channel.unblocked"
	TypeConversationBlocked   = "conversation.blocked"
	TypeConversationUnblocked = "conversation.unblocked"
)

// MessageCreated is emitted when a new message is appended to a conversation.
//
// Threading fields (ThreadID, ParentMessageID, IsThreadRoot) are OPTIONAL —
// they ride pointers + omitempty so producers from before the inbox migration
// emit clean JSON without the new keys, and consumers from before the migration
// silently ignore them. Canonical consumer-side default for ThreadID when
// absent is `conversationId` (one synthetic thread per legacy conversation).
type MessageCreated struct {
	Type            string  `json:"type"`
	EventID         string  `json:"eventId"`
	OrgID           string  `json:"orgId"`
	OccurredAt      string  `json:"occurredAt"`
	ConversationID  string  `json:"conversationId"`
	MessageID       string  `json:"messageId"`
	Seq             int64   `json:"seq"`
	SenderID        string  `json:"senderId"`
	RecipientID     string  `json:"recipientId"`
	Body            string  `json:"body"`
	ClientMsgID     string  `json:"clientMsgId"`
	ThreadID        *string `json:"threadId,omitempty"`
	ParentMessageID *string `json:"parentMessageId,omitempty"`
	IsThreadRoot    *bool   `json:"isThreadRoot,omitempty"`
	// Kind is omitted for ordinary text so pre-existing consumers see exactly
	// the JSON they saw before; set for system entries such as "call_missed".
	Kind string `json:"kind,omitempty"`
	// Origin is the thread's surface — 'chat' or 'mail'. The client patches its
	// inbox cache optimistically from this event, so without the origin it would
	// re-insert the very rows appendMessage now declines to write.
	Origin string `json:"origin,omitempty"`
	// ReplyToID is the message this one quotes, if any.
	ReplyToID string `json:"replyToId,omitempty"`
}

// ConversationIgnored is emitted when a participant ignores (hides) a conversation
// or a single thread inside it (ThreadID set, post-migration).
type ConversationIgnored struct {
	Type           string   `json:"type"`
	EventID        string   `json:"eventId"`
	OrgID          string   `json:"orgId"`
	OccurredAt     string   `json:"occurredAt"`
	ConversationID string   `json:"conversationId"`
	IgnoredBy      string   `json:"ignoredBy"`
	Members        []string `json:"members"`
	AtSeq          int64    `json:"atSeq"`
	ThreadID       *string  `json:"threadId,omitempty"`
}

// ConversationBlocked / ConversationUnblocked are emitted when a participant
// blocks or unblocks the other party of a 1:1 conversation. Fanned out to BOTH
// members so the blocked peer sees the "You have been blocked" banner live and
// the blocker's other devices stay in sync. Blocking gates message sends in
// EITHER direction until every member row is unblocked.
type ConversationBlocked struct {
	Type           string   `json:"type"`
	EventID        string   `json:"eventId"`
	OrgID          string   `json:"orgId"`
	OccurredAt     string   `json:"occurredAt"`
	ConversationID string   `json:"conversationId"`
	BlockedBy      string   `json:"blockedBy"`
	Members        []string `json:"members"`
}

type ConversationUnblocked struct {
	Type           string   `json:"type"`
	EventID        string   `json:"eventId"`
	OrgID          string   `json:"orgId"`
	OccurredAt     string   `json:"occurredAt"`
	ConversationID string   `json:"conversationId"`
	UnblockedBy    string   `json:"unblockedBy"`
	Members        []string `json:"members"`
}

// MessageRead is emitted when a participant advances their read marker.
type MessageRead struct {
	Type           string  `json:"type"`
	EventID        string  `json:"eventId"`
	OrgID          string  `json:"orgId"`
	OccurredAt     string  `json:"occurredAt"`
	ConversationID string  `json:"conversationId"`
	ReaderID       string  `json:"readerId"`
	UpToSeq        int64   `json:"upToSeq"`
	RecipientID    string  `json:"recipientId"`
	ThreadID       *string `json:"threadId,omitempty"`
}

// MessageDelivered is emitted by messaging-svc (NOT ws-gateway) when the
// recipient's gateway forwards a delivery ack — preserves outbox-then-Kafka.
type MessageDelivered struct {
	Type           string  `json:"type"`
	EventID        string  `json:"eventId"`
	OrgID          string  `json:"orgId"`
	OccurredAt     string  `json:"occurredAt"`
	ConversationID string  `json:"conversationId"`
	ThreadID       *string `json:"threadId,omitempty"`
	MessageID      string  `json:"messageId"`
	SenderID       string  `json:"senderId"`
	RecipientID    string  `json:"recipientId"`
	DeliveredAt    string  `json:"deliveredAt"`
}

// MessageDismissed is the sender-only "hide from my inbox" signal so multi-
// device sender views stay in sync.
type MessageDismissed struct {
	Type           string  `json:"type"`
	EventID        string  `json:"eventId"`
	OrgID          string  `json:"orgId"`
	OccurredAt     string  `json:"occurredAt"`
	ConversationID string  `json:"conversationId"`
	ThreadID       *string `json:"threadId,omitempty"`
	MessageID      string  `json:"messageId"`
	DismissedBy    string  `json:"dismissedBy"`
}

// MessageDeleted is "delete for everyone": the message is now a tombstone for
// BOTH parties. Routed to `Members` so the other side swaps the bubble out
// immediately — a delete the recipient only learns about at their next refetch
// is one they may well have screenshotted first.
//
// Deliberately distinct from MessageDismissed, which is the SENDER-ONLY inbox
// hide and changes nothing for the recipient.
type MessageDeleted struct {
	Type           string   `json:"type"`
	EventID        string   `json:"eventId"`
	OrgID          string   `json:"orgId"`
	OccurredAt     string   `json:"occurredAt"`
	ConversationID string   `json:"conversationId"`
	ThreadID       *string  `json:"threadId,omitempty"`
	MessageID      string   `json:"messageId"`
	DeletedBy      string   `json:"deletedBy"`
	Members        []string `json:"members"`
}

// MessageReaction announces that SOMETHING about one message's reactions
// changed, and carries no counts.
//
// Deliberate: the tally is per-viewer (`mine` differs between the two parties),
// so a payload of numbers would be right for the actor and wrong for everyone
// else. Each client refetches its own view instead — one small query on a
// change a human just made by hand, which is not a rate worth optimising.
type MessageReaction struct {
	Type           string `json:"type"`
	EventID        string `json:"eventId"`
	OrgID          string `json:"orgId"`
	OccurredAt     string `json:"occurredAt"`
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId"`
	// Who toggled — used to skip the actor's own echo.
	ActorID string   `json:"actorId"`
	Members []string `json:"members"`
}

// MessageForwarded records one hop of internal-relay forward tracking. When B
// forwards A's message to C, the message C actually receives rides its own
// co-emitted MessageCreated (which owns delivery/read acks and the chat/inbox
// UX). This event is the separate PROVENANCE signal whose purpose is to reach
// the ORIGINAL author A. RootAuthorID is embedded so the gateway routes to A
// without a DB lookup. Outbound-to-external forward (Platform != "blisswork"):
// there is no clone, so ForwardedMessageID/ThreadID/Seq are empty and
// ForwardedToExternal carries the external handle instead of ForwardedTo.
//
// Delivery/ForwardedToName/ChannelID were added for deep-link forwarding and are
// omitempty, so producers and consumers from before it emit and read exactly the
// JSON they did before.
type MessageForwarded struct {
	Type                string  `json:"type"`
	EventID             string  `json:"eventId"`
	OrgID               string  `json:"orgId"`
	OccurredAt          string  `json:"occurredAt"`
	ConversationID      string  `json:"conversationId"`
	RootMessageID       string  `json:"rootMessageId"`
	RootAuthorID        string  `json:"rootAuthorId"`
	ParentMessageID     string  `json:"parentMessageId"`
	ForwardedBy         string  `json:"forwardedBy"`
	ForwardedTo         string  `json:"forwardedTo,omitempty"`
	ForwardedToExternal string  `json:"forwardedToExternal,omitempty"`
	Platform            string  `json:"platform"`
	Depth               int     `json:"depth"`
	BodyPreview         string  `json:"bodyPreview"`
	ForwardedMessageID  string  `json:"forwardedMessageId,omitempty"`
	ThreadID            *string `json:"threadId,omitempty"`
	Seq                 int64   `json:"seq,omitempty"`
	// Delivery is "confirmed" when a provider acknowledged the send, and
	// "unconfirmed" for a deep link — we opened WhatsApp and lost sight of it.
	// The original author is told which; presenting the two alike would make
	// this event claim more than it knows.
	Delivery string `json:"delivery,omitempty"`
	// ForwardedToName is the captured contact's display name, so the author
	// reads "forwarded to Jane Doe" rather than a bare number.
	ForwardedToName string `json:"forwardedToName,omitempty"`
	// ChannelID is set when the forwarded message lives in a channel rather
	// than a 1:1 conversation. Routing is unaffected — this event still goes
	// only to the forwarder and the original author, never the whole channel.
	ChannelID string `json:"channelId,omitempty"`
}

// ChannelMessageCreated is emitted when a new message is appended to a group channel.
type ChannelMessageCreated struct {
	Type           string   `json:"type"`
	EventID        string   `json:"eventId"`
	OrgID          string   `json:"orgId"`
	OccurredAt     string   `json:"occurredAt"`
	ChannelID      string   `json:"channelId"`
	MessageID      string   `json:"messageId"`
	Seq            int64    `json:"seq"`
	SenderID       string   `json:"senderId"`
	SenderUsername string   `json:"senderUsername"`
	Body           string   `json:"body"`
	Members        []string `json:"members"`
	// SenderDisplayName is the sender's real name. Omitted when the projection
	// has no display_name, so consumers that predate it are unaffected and
	// clients fall back to senderUsername (the email local-part).
	SenderDisplayName string `json:"senderDisplayName,omitempty"`
	// Kind mirrors MessageCreated.Kind — omitted for ordinary text so the wire
	// shape is unchanged for consumers that predate channel system entries.
	Kind string `json:"kind,omitempty"`
}

// ChannelMemberJoined is emitted when a user joins a channel (open self-
// join via JoinChannel, OR added by an existing member via AddChannelMembers).
// task-svc consumes this to retroactively assign any active channel tasks
// to the new member so they catch up to outstanding commitments.
type ChannelMemberJoined struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	ChannelID  string `json:"channelId"`
	UserID     string `json:"userId"`
	Username   string `json:"username"`
}

// UserCreated is consumed from auth.events to maintain the user_projection.
type UserCreated struct {
	Type        string `json:"type"`
	EventID     string `json:"eventId"`
	OrgID       string `json:"orgId"`
	OccurredAt  string `json:"occurredAt"`
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

// MembershipChanged carries user.deactivated / user.reactivated / user.removed.
// The projection row is KEPT in every case — a departed member's name still has
// to render on the messages and channels they left behind. Only the `active`
// flag moves, so pickers and rosters can stop offering them.
type MembershipChanged struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	UserID     string `json:"userId"`
	ActorID    string `json:"actorId,omitempty"`
}

// ChannelMembershipChanged carries every channel moderation event:
// member.removed, member.role_changed, blocked and unblocked.
//
// `Members` is the SURVIVING roster and `UserID` is the person acted upon — who
// by definition is usually no longer in it. The gateway routes to
// dedupe(Members + UserID) so the removed member's own client learns what
// happened rather than silently going stale until the next refetch.
type ChannelMembershipChanged struct {
	Type       string   `json:"type"`
	EventID    string   `json:"eventId"`
	OrgID      string   `json:"orgId"`
	OccurredAt string   `json:"occurredAt"`
	ChannelID  string   `json:"channelId"`
	UserID     string   `json:"userId"`
	ActorID    string   `json:"actorId,omitempty"`
	Members    []string `json:"members"`
}
