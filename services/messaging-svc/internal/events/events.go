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
	TypeUserCreated           = "user.created"
	TypeChannelMessageCreated = "channel.message.created"
	TypeChannelMemberJoined   = "channel.member.joined"
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
