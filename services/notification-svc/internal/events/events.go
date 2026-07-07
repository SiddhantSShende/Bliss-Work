package events

// Kafka topics (canonical contract).
const (
	TopicTask         = "task.events.v1"
	TopicNotification = "notification.events.v1"
	// TopicNotificationDLQ receives malformed (unparseable) messages so a poison
	// pill cannot block its partition. Mirrors the notification.events.v1 stream.
	TopicNotificationDLQ = "notification.events.v1.dlq"
)

// Event type discriminants.
const (
	TypeTaskAcknowledged    = "task.acknowledged"
	TypeTaskCompleted       = "task.completed"
	TypeTaskIgnored         = "task.ignored"
	TypeTaskLeft            = "task.left"
	TypeNotificationCreated = "notification.created"
)

// Notification kinds.
const (
	KindTaskAcknowledged = "TASK_ACKNOWLEDGED"
	KindTaskCompleted    = "TASK_COMPLETED"
	KindTaskIgnored      = "TASK_IGNORED"
	KindTaskLeft         = "TASK_LEFT"
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
