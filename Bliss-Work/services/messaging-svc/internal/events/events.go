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
	TypeMessageForwarded    = "message.forwarded"
	TypeUserCreated         = "user.created"
	TypeUserDeactivated     = "user.deactivated"
	TypeUserReactivated     = "user.reactivated"
	TypeUserRemoved         = "user.removed"
	// TypeOrgDeleted is keyed by orgId rather than userId — see the topic note
	// in packages/shared/src/types/events.ts.
	TypeOrgDeleted             = "org.deleted"
	TypeChannelMessageCreated  = "channel.message.created"
	TypeChannelMessageDeleted  = "channel.message.deleted"
	TypeChannelMessageReaction = "channel.message.reaction"
	TypeChannelMessagePinned   = "channel.message.pinned"
	TypeChannelMemberJoined    = "channel.member.joined"
	TypeChannelMemberRemoved   = "channel.member.removed"
	TypeChannelRoleChanged     = "channel.member.role_changed"
	TypeChannelBlocked         = "channel.blocked"
	TypeChannelUnblocked       = "channel.unblocked"
	TypeConversationBlocked    = "conversation.blocked"
	TypeConversationUnblocked  = "conversation.unblocked"

	// Call lifecycle. All of these route by `members`, which is what lets a
	// cross-org meeting notify a participant in another org without the
	// gateway needing to know that is what happened.
	TypeCallScheduled        = "call.scheduled"
	TypeCallRing             = "call.ring"
	TypeCallParticipantAdded = "call.participant_added"
	TypeCallEnded            = "call.ended"
	// TypeCallParticipantLeft is an ordinary participant leaving a call that
	// keeps going for everyone else (contrast TypeCallEnded, which is the whole
	// call closing). Addressed to the live roster AND the leaver themselves —
	// see notifyParticipantLeft — because by the time this fires the leaver's
	// own call_participants row already has left_at set, so the default
	// roster read would otherwise miss the one recipient this event exists
	// for: the leaver's OTHER open sessions/devices.
	TypeCallParticipantLeft = "call.participant_left"
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

	// Mail. TypeMailDelivered is the in-app signal that a mail landed in
	// someone's Inbox; TypeMailOutbound is the instruction to email-worker to
	// put one copy on the wire over SMTP. They are separate events because they
	// have disjoint audiences — the first is routed to user sockets, the second
	// is never delivered to a client at all (see ws-gateway's contract package).
	TypeMailDelivered = "mail.delivered"
	TypeMailOutbound  = "mail.outbound"
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
	// IsForward marks a delivered copy of someone else's message, so the
	// receiving client labels it instead of attributing it to the forwarder.
	IsForward bool `json:"isForward,omitempty"`
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

// MessageForwarded is the PROVENANCE signal for a deep-link forward: the
// forwarder opened WhatsApp with one of this org's messages prefilled. Its
// purpose is to reach the ORIGINAL author of that message, so RootAuthorID is
// embedded and the gateway routes on it without a DB lookup.
//
// It is not a delivery signal and must not be presented as one. A wa.me link
// hands the message to the operating system and ends our visibility — the user
// may never press send — so Delivery is always "unconfirmed" on this path and
// every consumer words it as "opened WhatsApp to forward", never "forwarded".
//
// Routing note: this goes only to the forwarder and the original author, never
// to a whole channel, even when ChannelID is set.
type MessageForwarded struct {
	Type            string `json:"type"`
	EventID         string `json:"eventId"`
	OrgID           string `json:"orgId"`
	OccurredAt      string `json:"occurredAt"`
	ConversationID  string `json:"conversationId"`
	RootMessageID   string `json:"rootMessageId"`
	RootAuthorID    string `json:"rootAuthorId"`
	ParentMessageID string `json:"parentMessageId"`
	ForwardedBy     string `json:"forwardedBy"`
	// ForwardedToExternal is the target in bare E.164 digits, on the deep-link
	// path only — that forward leaves the org, so there is no user to name.
	ForwardedToExternal string `json:"forwardedToExternal,omitempty"`
	// ForwardedTo / ForwardedToChannelID name the destination of an INTERNAL
	// forward, exactly one of the two being set. Both are empty on the
	// deep-link path, where the recipient is chosen inside WhatsApp and never
	// reported back.
	ForwardedTo          string `json:"forwardedTo,omitempty"`
	ForwardedToChannelID string `json:"forwardedToChannelId,omitempty"`
	// ForwardedMessageID is the clone delivered to that destination. Empty on
	// the deep-link path, which creates no message.
	ForwardedMessageID string `json:"forwardedMessageId,omitempty"`
	Platform           string `json:"platform"`
	Depth              int    `json:"depth"`
	BodyPreview        string `json:"bodyPreview"`
	// Delivery is "confirmed" for an internal forward — the clone is in this
	// database — and "unconfirmed" for every deep link, which hands the message
	// to the operating system and ends our visibility. The field is kept rather
	// than implied so the claim travels with the event instead of living only
	// in a consumer's assumption.
	Delivery string `json:"delivery,omitempty"`
	// ForwardedToName is the captured contact's display name, so the author
	// reads "opened WhatsApp to forward to Jane Doe" rather than a bare number.
	ForwardedToName string `json:"forwardedToName,omitempty"`
	// ChannelID is set when the forwarded message lives in a channel rather
	// than a 1:1 conversation.
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
	// IsForward marks a delivered copy of someone else's message, so the
	// receiving client labels it instead of attributing it to the forwarder.
	IsForward bool `json:"isForward,omitempty"`
}

// ChannelMessageDeleted is the channel twin of MessageDeleted: one message was
// tombstoned for everyone in the channel.
//
// `DeletedBy` is carried because in a channel it is routinely NOT the author —
// an owner, a channel admin or an org_admin moderating someone else's message
// is the main reason the capability exists, and a client that renders "deleted"
// without saying who is hiding the only interesting part.
type ChannelMessageDeleted struct {
	Type       string   `json:"type"`
	EventID    string   `json:"eventId"`
	OrgID      string   `json:"orgId"`
	OccurredAt string   `json:"occurredAt"`
	ChannelID  string   `json:"channelId"`
	MessageID  string   `json:"messageId"`
	DeletedBy  string   `json:"deletedBy"`
	Members    []string `json:"members"`
}

// ChannelMessageReaction announces that something about one channel message's
// reactions changed, and — exactly as MessageReaction does — carries no counts.
// The tally is per-viewer (`mine` differs per member), so numbers computed for
// the actor would be wrong for everyone else; each client refetches its own.
type ChannelMessageReaction struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	ChannelID  string `json:"channelId"`
	MessageID  string `json:"messageId"`
	// Who toggled — used to skip the actor's own echo.
	ActorID string   `json:"actorId"`
	Members []string `json:"members"`
}

// ChannelMessagePinned covers both directions: `Pinned` false is an unpin.
// One event type rather than two because every consumer treats it as "this
// message's pin state changed, re-render it".
type ChannelMessagePinned struct {
	Type       string   `json:"type"`
	EventID    string   `json:"eventId"`
	OrgID      string   `json:"orgId"`
	OccurredAt string   `json:"occurredAt"`
	ChannelID  string   `json:"channelId"`
	MessageID  string   `json:"messageId"`
	Pinned     bool     `json:"pinned"`
	ActorID    string   `json:"actorId"`
	Members    []string `json:"members"`
}

// ChannelMemberJoined is emitted when a user joins a channel (open self-
// join via JoinChannel, OR added by an existing member via AddChannelMembers).
//
// Two consumers, and they need different things from it:
//   - task-svc retroactively assigns active channel tasks to the new member so
//     they catch up to outstanding commitments. It keys off UserID alone.
//   - notification-svc turns it into a "You were added to #general" row in the
//     bell, and the ws-gateway routes it to UserID so their client learns
//     about the channel without a refetch.
//
// ChannelName and ActorID exist for that second consumer and are the reason
// this event grew past what task-svc reads:
//
//   - ChannelName, because a notification that says "you were added to
//     3f2b91c4-…" is not a notification. Resolved by the producer, which
//     already holds the channel row; a consumer would need a second service.
//   - ActorID, because a SELF-join must not notify. Telling someone they were
//     added to a channel they just clicked "Join" on is noise, and it is the
//     only thing separating the two producers. actorID == userID means the
//     user did it to themselves.
type ChannelMemberJoined struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	ChannelID  string `json:"channelId"`
	// ChannelName is the channel's display name at the time of the join.
	// Deliberately a snapshot: the notification records what the user was told,
	// and a later rename does not retroactively change what happened.
	ChannelName string `json:"channelName,omitempty"`
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	// ActorID is who performed the add. Equal to UserID for an open-channel
	// self-join. Omitted by producers that predate it, which consumers must
	// treat as "unknown actor", NOT as a self-join.
	ActorID string `json:"actorId,omitempty"`
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
	// Email is the member's account address, denormalized into
	// user_projection.email. Two things depend on it and both fail silently
	// without it: resolveMailRecipients matches a typed address to a member (an
	// unmatched colleague is treated as an outside address and gets no in-app
	// delivery), and loadSendableDraft stamps it as the From: header on mail
	// that member composes (an empty one falls back to the deployment's own
	// relay address, so the mail arrives from the wrong person).
	//
	// Empty on events produced before auth-svc started sending it. UpsertUser
	// therefore leaves an existing value alone rather than blanking it — see
	// scripts/backfill-user-emails.py for the one-off fill.
	Email string `json:"email"`
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

// MailDelivered announces that a mail was delivered into one or more people's
// Inbox. Routed to `Members` — every local recipient plus the author, whose
// other devices need the Sent copy to appear too.
//
// Deliberately carries NO content: subject and body would otherwise be written
// into every recipient's Redis replay ZSET, and the client's only reaction to
// this event is to refetch the feed row it already knows how to render.
type MailDelivered struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	MailID     string `json:"mailId"`
	// SenderID is left unset (and therefore omitted, not "") for inbound mail —
	// DeliverInboundMail has no local author to name. omitempty matters here:
	// the shared TS contract types this `z.string().uuid().optional()`, which
	// accepts an ABSENT key but rejects an empty string, so without omitempty
	// every inbound MailDelivered event fails ServerEvent.safeParse() on the
	// client and is silently dropped — the mail lands in the DB and the REST
	// feed, but nothing tells an open client to refetch it.
	SenderID string   `json:"senderId,omitempty"`
	Members  []string `json:"members"`
}

// MailOutbound is ONE copy of a mail bound for ONE address outside the org,
// consumed by email-worker and handed to SMTP.
//
// One event per external recipient rather than one event with a recipient list.
// That is what keeps Bcc private: the envelope address is per-event, while To
// and Cc are the display header every copy shares, so a Bcc'd address never
// appears in anybody else's message — including their own.
type MailOutbound struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	MailID     string `json:"mailId"`
	// Envelope is the single RCPT TO for this copy.
	Envelope string `json:"envelope"`
	// AuthorID is the member who composed the mail. email-worker uses it to ask
	// integrations-svc whether that member has a connected mailbox to send
	// through — mail sent that way carries their real identity, lands in their
	// provider's Sent folder, and is authenticated by their own domain instead
	// of by this deployment's relay. Empty on events produced before it existed,
	// which simply means the relay is the only option for that copy.
	AuthorID    string   `json:"authorId"`
	FromAddress string   `json:"fromAddress"`
	FromName    string   `json:"fromName"`
	To          []string `json:"to"`
	Cc          []string `json:"cc"`
	Subject     string   `json:"subject"`
	BodyText    string   `json:"bodyText"`
	// ProviderCopy marks the ONE copy that owns the send through the author's
	// connected mailbox, and the three fields below are that send's whole
	// recipient list. A mailbox provider has no envelope/header split — it
	// delivers to exactly the addresses in the headers it is given — so the
	// per-envelope fan-out that SMTP needs cannot be expressed there. One copy
	// therefore carries the entire external recipient list and the rest defer to
	// its outcome (see email-worker's mail_transport record).
	//
	// Members of this org are deliberately ABSENT from these lists even when
	// they were addressed: they already have the mail in their BlissWork Inbox,
	// and a provider that delivered to them as well would put a second,
	// duplicate copy in front of them.
	ProviderCopy bool     `json:"providerCopy,omitempty"`
	ProviderTo   []string `json:"providerTo,omitempty"`
	ProviderCc   []string `json:"providerCc,omitempty"`
	// ProviderBcc stays a Bcc at the provider too, so a blind copy is still
	// blind — it is the one part of the envelope/header split that survives.
	ProviderBcc []string `json:"providerBcc,omitempty"`
	// Attachments is METADATA ONLY — the bytes stay in the blob store and
	// email-worker fetches each one over the internal API when it builds the
	// message. A Kafka topic is the wrong place to carry a 10 MB file: the
	// broker's default message cap is 1 MB, every copy of a mail would carry
	// its own duplicate of the bytes, and the topic's retention would keep them
	// long after the mail was delivered.
	Attachments []MailOutboundAttachment `json:"attachments,omitempty"`
}

// MailOutboundAttachment names one file on an outbound mail. `ID` is what
// email-worker asks the internal API for; the rest is what it needs to build the
// MIME part, and to decide what fits before fetching a single byte.
type MailOutboundAttachment struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	Mime      string `json:"mime"`
	SizeBytes int64  `json:"sizeBytes"`
}
