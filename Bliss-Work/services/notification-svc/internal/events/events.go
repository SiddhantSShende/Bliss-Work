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
	// TopicMessaging is read for channel.member.joined only — being added to a
	// channel by someone else is a notification, and messaging-svc is the only
	// service that knows it happened.
	//
	// This does mean the consumer group receives every chat message on the
	// platform and discards almost all of it. That is the cost of the one event
	// worth having, it is bounded by a `type` check before any database work,
	// and task-svc already carries the same stream for the same event.
	TopicMessaging = "messaging.events.v1"
)

// Event type discriminants.
const (
	TypeTaskAcknowledged    = "task.acknowledged"
	TypeTaskCompleted       = "task.completed"
	TypeTaskIgnored         = "task.ignored"
	TypeTaskLeft            = "task.left"
	TypeNotificationCreated = "notification.created"
	TypeNotificationRead    = "notification.read"
	TypeOrgDeleted          = "org.deleted"
	TypeChannelMemberJoined = "channel.member.joined"
)

// Notification kinds.
const (
	KindTaskAcknowledged = "TASK_ACKNOWLEDGED"
	KindTaskCompleted    = "TASK_COMPLETED"
	KindTaskIgnored      = "TASK_IGNORED"
	KindTaskLeft         = "TASK_LEFT"
	KindChannelAdded     = "CHANNEL_ADDED"
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
	Type        string `json:"type"`
	EventID     string `json:"eventId"`
	OrgID       string `json:"orgId"`
	OccurredAt  string `json:"occurredAt"`
	ChannelID   string `json:"channelId"`
	ChannelName string `json:"channelName"`
	UserID      string `json:"userId"`
	ActorID     string `json:"actorId"`
}

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
