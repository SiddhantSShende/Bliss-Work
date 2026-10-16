package events

// Kafka topics (canonical contract).
const (
	TopicTask         = "task.events.v1"
	TopicNotification = "notification.events.v1"
	// TopicNotificationDLQ receives malformed (unparseable) messages so a poison
	// pill cannot block its partition. Mirrors the notification.events.v1 stream.
	TopicNotificationDLQ = "notification.events.v1.dlq"
	// TopicAuth is read for org.deleted only. Notifications carry task titles
	// and message previews, so an erased workspace has to take them with it.
	TopicAuth = "auth.events"
	// TopicMessaging is read for channel.member.joined and message-created
	// events, which notification-svc projects into persisted channel/DM alerts.
	//
	// This means the consumer group receives every chat message on the platform.
	// Irrelevant event types are discarded by a type check before database work.
	TopicMessaging = "messaging.events.v1"
)

// Event type discriminants.
const (
	TypeTaskAssigned          = "task.assigned"
	TypeTaskAcknowledged      = "task.acknowledged"
	TypeTaskCompleted         = "task.completed"
	TypeTaskIgnored           = "task.ignored"
	TypeTaskLeft              = "task.left"
	TypeTaskWithdrawn         = "task.withdrawn"
	TypeNotificationCreated   = "notification.created"
	TypeNotificationRead      = "notification.read"
	TypeOrgDeleted            = "org.deleted"
	TypeChannelMemberJoined   = "channel.member.joined"
	TypeMessageCreated        = "message.created"
	TypeChannelMessageCreated = "channel.message.created"
	TypeCallScheduled         = "call.scheduled"
	TypeCallRing              = "call.ring"
	TypeCallStarted           = "call.started"
	TypeCallEnded             = "call.ended"
	TypeCallParticipantAdded  = "call.participant_added"
	// TypeCallMissed is the one call.* event with a bell counterpart — see
	// KindCallMissed. TypeCallDeclined and TypeCallNoAnswer are deliberately
	// absent here: both are realtime-only (no notification row), so this
	// consumer has no reason to decode them.
	TypeCallMissed = "call.missed"
)

// Notification kinds.
const (
	KindTaskAssigned     = "TASK_ASSIGNED"
	KindTaskAcknowledged = "TASK_ACKNOWLEDGED"
	KindTaskCompleted    = "TASK_COMPLETED"
	KindTaskIgnored      = "TASK_IGNORED"
	KindTaskLeft         = "TASK_LEFT"
	KindTaskWithdrawn    = "TASK_WITHDRAWN"
	KindChannelAdded     = "CHANNEL_ADDED"
	KindChannelCreated   = "CHANNEL_CREATED"
	KindDMMessage        = "DM_MESSAGE"
	KindChannelMessage   = "CHANNEL_MESSAGE"
	KindMeetingScheduled = "MEETING_SCHEDULED"
	KindMeetingInvite    = "MEETING_INVITATION"
	KindMeetingUpdated   = "MEETING_UPDATED"
	KindMeetingStarted   = "MEETING_STARTED"
	KindMeetingCancelled = "MEETING_CANCELLED"
	// KindCallAdded is a person being rung into an ad-hoc call (a conference): a
	// call, not a meeting, so it is not a MEETING_* kind.
	KindCallAdded = "CALL_ADDED"
	// KindCallMissed is the one call.* notification with a bell counterpart —
	// see messaging-svc's events.TypeCallMissed doc comment for why: its
	// recipient may not have been looking at a screen when the ring expired.
	KindCallMissed = "CALL_MISSED"
)

// TaskEvent is the shape consumed off task.events.v1. It is a superset that
// captures every field used by acknowledged/completed events; the discriminant
// is `type`.
type TaskEvent struct {
	Type             string `json:"type"`
	EventID          string `json:"eventId"`
	OrgID            string `json:"orgId"`
	OccurredAt       string `json:"occurredAt"`
	TaskID           string `json:"taskId"`
	AssigneeID       string `json:"assigneeId"`
	SenderID         string `json:"senderId"`
	StatusVersion    int    `json:"statusVersion"`
	AssigneeUsername string `json:"assigneeUsername"`
	SenderUsername   string `json:"senderUsername"`
	Title            string `json:"title"`
}

// ChannelMemberJoined is the shape consumed off messaging.events.v1.
//
// Only the added-by-someone-else case becomes a notification: ActorID is the
// user who performed the add, so `ActorID == UserID` is an open-channel
// self-join and is ignored. An EMPTY ActorID is a producer that predates the
// field and is ignored too — a notification that might be telling someone about
// their own click is worse than one that is missing, and the ambiguity resolves
// itself as soon as messaging-svc is deployed.
type ChannelMemberJoined struct {
	Type             string `json:"type"`
	EventID          string `json:"eventId"`
	OrgID            string `json:"orgId"`
	OccurredAt       string `json:"occurredAt"`
	ChannelID        string `json:"channelId"`
	ChannelName      string `json:"channelName"`
	UserID           string `json:"userId"`
	ActorID          string `json:"actorId"`
	ActorDisplayName string `json:"actorDisplayName"`
}

type MessageCreated struct {
	Type              string `json:"type"`
	EventID           string `json:"eventId"`
	OrgID             string `json:"orgId"`
	ConversationID    string `json:"conversationId"`
	MessageID         string `json:"messageId"`
	SenderID          string `json:"senderId"`
	RecipientID       string `json:"recipientId"`
	Body              string `json:"body"`
	Kind              string `json:"kind,omitempty"`
	Origin            string `json:"origin,omitempty"`
	SenderDisplayName string `json:"senderDisplayName,omitempty"`
	SenderUsername    string `json:"senderUsername,omitempty"`
}

type ChannelMessageCreated struct {
	Type              string   `json:"type"`
	EventID           string   `json:"eventId"`
	OrgID             string   `json:"orgId"`
	ChannelID         string   `json:"channelId"`
	MessageID         string   `json:"messageId"`
	SenderID          string   `json:"senderId"`
	SenderUsername    string   `json:"senderUsername"`
	SenderDisplayName string   `json:"senderDisplayName,omitempty"`
	ChannelName       string   `json:"channelName,omitempty"`
	Body              string   `json:"body"`
	Kind              string   `json:"kind,omitempty"`
	Members           []string `json:"members"`
}

type CallLifecycle struct {
	Type        string `json:"type"`
	EventID     string `json:"eventId"`
	OrgID       string `json:"orgId"`
	OccurredAt  string `json:"occurredAt"`
	CallID      string `json:"callId"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	ScheduledAt string `json:"scheduledAt"`
	ActorID     string `json:"actorId"`
	// ActorName is the actor's display name, set by messaging-svc on call.ring.
	ActorName string   `json:"actorName"`
	Members   []string `json:"members"`
	// Status is the call's status when the event was emitted: LIVE on a start,
	// CANCELLED on the call.ended that withdraws a meeting that never happened
	// (as opposed to ENDED, a meeting that did).
	Status string `json:"status"`
	// Change is "updated" on a call.scheduled that re-announces an edited meeting.
	Change string `json:"change"`
}

// CallChangeUpdated is CallLifecycle.Change for an edited meeting (messaging-svc
// events.ChangeUpdated).
const CallChangeUpdated = "updated"

// Call statuses this service distinguishes (messaging-svc store.CallLive / CallCancelled).
const (
	CallStatusLive      = "LIVE"
	CallStatusCancelled = "CANCELLED"
)

// NotificationCreated is the event written to the outbox / produced to
// notification.events.v1. Field order/names match the canonical contract.
type NotificationCreated struct {
	Type           string  `json:"type"`
	EventID        string  `json:"eventId"`
	OrgID          string  `json:"orgId"`
	OccurredAt     string  `json:"occurredAt"`
	NotificationID string  `json:"notificationId"`
	RecipientID    string  `json:"recipientId"`
	Kind           string  `json:"kind"`
	Text           string  `json:"text"`
	TaskID         *string `json:"taskId,omitempty"`
	ChannelID      *string `json:"channelId,omitempty"`
	ConversationID *string `json:"conversationId,omitempty"`
	MessageID      *string `json:"messageId,omitempty"`
	CallID         *string `json:"callId,omitempty"`
}

// NotificationRead is emitted by the HTTP API after a notification (or the
// caller's whole unread set) is marked read, so every other active session
// for the same recipient — another browser tab, another device, the desktop
// app — drops the bell badge without a manual refresh. NotificationID is set
// for a single mark-read and omitted for mark-all, matching how TaskID is
// optional on NotificationCreated above. Only emitted when a row actually
// flipped from unread to read — a re-click on an already-read row, or an
// empty mark-all, produces no event.
type NotificationRead struct {
	Type           string  `json:"type"`
	EventID        string  `json:"eventId"`
	OrgID          string  `json:"orgId"`
	OccurredAt     string  `json:"occurredAt"`
	RecipientID    string  `json:"recipientId"`
	NotificationID *string `json:"notificationId,omitempty"`
}
