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
	TypeMessageCreated      = "message.created"
	TypeConversationIgnored = "conversation.ignored"
	TypeMessageRead         = "message.read"
	TypeMessageDelivered    = "message.delivered"
	TypeMessageDismissed    = "message.dismissed"
	TypeMessageDeleted      = "message.deleted"
	TypeMessageReaction     = "message.reaction"
	TypeUserCreated         = "user.created"
	TypeUserDeactivated     = "user.deactivated"
	TypeUserReactivated     = "user.reactivated"
	TypeUserRemoved         = "user.removed"
	// TypeOrgDeleted is keyed by orgId rather than userId — see the topic note
	// in packages/shared/src/types/events.ts.
	TypeOrgDeleted            = "org.deleted"
	TypeChannelMessageCreated = "channel.message.created"
	TypeChannelMemberJoined   = "channel.member.joined"
	TypeChannelMemberRemoved  = "channel.member.removed"
	TypeChannelRoleChanged    = "channel.member.role_changed"
	TypeChannelBlocked        = "channel.blocked"
	TypeChannelUnblocked      = "channel.unblocked"
	TypeConversationBlocked   = "conversation.blocked"
	TypeConversationUnblocked = "conversation.unblocked"

	// Call lifecycle. All of these route by `members`, which is what lets a
	// cross-org meeting notify a participant in another org without the
	// gateway needing to know that is what happened.
	TypeCallScheduled        = "call.scheduled"
	TypeCallRing             = "call.ring"
	TypeCallParticipantAdded = "call.participant_added"
	TypeCallEnded            = "call.ended"
	// TypeCallStarted is the end of the waiting room. Addressed to the whole
	// roster, because it means two different things at once depending on where
	// the recipient is: everyone parked in the lobby is now admitted and should
	// enter, and everyone who has not opened it yet now can.
	TypeCallStarted = "call.started"
	// TypeCallWaiting says somebody is in the lobby. Addressed ONLY to the
	// people who could start the call — it is what tells an organiser their
	// meeting has an audience waiting on it. Not an approval request: there is
	// nothing to approve, and starting the call admits everyone at once.
	TypeCallWaiting = "call.waiting"
	// Screen sharing. ActorID is the sharer; ShareSource says what they picked.
	TypeCallShareStarted = "call.screenshare_started"
	TypeCallShareStopped = "call.screenshare_stopped"
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

// CallLifecycle carries every call notification: scheduled, ring,
// participant_added, ended, started, waiting, and the two screen-share ones.
//
// One struct for all of them because the gateway routes them identically —
// `Members` is the recipient list and RecipientsOf returns it verbatim. That
// routing is what makes a CROSS-ORG meeting work without special-casing anything
// in the gateway: the roster of a meeting simply contains a user from another
// org, and the Kafka fan-out path has never cared which org a recipient belongs
// to. The same-org rule lives on the RTC signaling path, which these do not use.
//
// `Members` is a RECIPIENT list rather than a roster, and the distinction earns
// its keep on call.waiting: that one goes to the handful of people who could
// start the call, not to everyone in it. The producer decides who should hear
// each event; the gateway delivers to whoever is named.
type CallLifecycle struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	CallID     string `json:"callId"`
	Kind       string `json:"kind"`
	ChannelID  string `json:"channelId,omitempty"`
	Title      string `json:"title,omitempty"`
	Media      string `json:"media,omitempty"`
	Status     string `json:"status,omitempty"`
	// ScheduledAt is absent for "meet now".
	ScheduledAt string `json:"scheduledAt,omitempty"`
	// ActorID is who caused this — the organiser, the person who added someone,
	// the host who ended or started it, the person who arrived in the lobby, or
	// the one who started sharing their screen.
	ActorID string `json:"actorId,omitempty"`
	// ShareSource is SCREEN, WINDOW or TAB, on the screen-share events only.
	ShareSource string `json:"shareSource,omitempty"`
	// Members is who should RECEIVE this, which is usually but not always the
	// roster — call.waiting goes only to the people who could start the call.
	Members []string `json:"members"`
}
