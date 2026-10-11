/** CANONICAL EVENT CONTRACT (zod) — single source of truth for Kafka events +
 *  server→client WS frames; Go/Python structs mirror it. Conventions: `orgId`
 *  tenant, `eventId` (UUIDv7) dedup, discrete per-transition types, JSON. */
import { z } from "zod";
import { CallShareSource, MessageKindWire, ThreadOrigin } from "./domain";

// ── Kafka topics ────────────────────────────────────────────────────────────
export const Topics = {
  Messaging: "messaging.events.v1", // key = conversationId
  Task: "task.events.v1", // key = taskId
  Notification: "notification.events.v1", // key = recipientId
  Integration: "integration.events.v1", // key = recipientId (external-integration hub activity)
  // key = userId, EXCEPT the org.* lifecycle events, which are keyed by orgId.
  // They are about the workspace rather than any one person, and keying them by
  // org is what keeps a delete ordered against that org's other auth events on
  // the same partition.
  Auth: "auth.events",
} as const;
export type TopicName = (typeof Topics)[keyof typeof Topics];

// ── Event type discriminants ─────────────────────────────────────────────────
export const EventType = {
  MessageCreated: "message.created",
  ConversationIgnored: "conversation.ignored",
  ConversationBlocked: "conversation.blocked",
  ConversationUnblocked: "conversation.unblocked",
  MessageRead: "message.read",
  MessageDelivered: "message.delivered",
  MessageDismissed: "message.dismissed",
  MessageDeleted: "message.deleted",
  MessageReaction: "message.reaction",
  MessageForwarded: "message.forwarded",
  ChannelMessageCreated: "channel.message.created",
  ChannelMessageDeleted: "channel.message.deleted",
  ChannelMessageReaction: "channel.message.reaction",
  ChannelMessagePinned: "channel.message.pinned",
  ChannelMemberJoined: "channel.member.joined",
  ChannelMemberRemoved: "channel.member.removed",
  ChannelRoleChanged: "channel.member.role_changed",
  ChannelBlocked: "channel.blocked",
  ChannelUnblocked: "channel.unblocked",
  TaskAssigned: "task.assigned",
  TaskWithdrawn: "task.withdrawn",
  TaskAcknowledged: "task.acknowledged",
  TaskCompleted: "task.completed",
  TaskIgnored: "task.ignored",
  TaskLeft: "task.left",
  /** Emitted by task-svc's deadline sweeper (never a client action): this
   *  assignment's deadline passed before it was completed. */
  TaskMissed: "task.missed",
  TaskReviewed: "task.reviewed",
  /** Internal-only, like OrgDeleted below: an admin hard-deleted the task via
   *  task-svc's internal by-title endpoint. Never pushed to a client socket —
   *  it exists so sticky-svc's pins and messaging-svc's inbox rows, which only
   *  close on a terminal task.* event, don't go stale forever for a task that
   *  bypassed the normal lifecycle. */
  TaskDeleted: "task.deleted",
  NotificationCreated: "notification.created",
  NotificationRead: "notification.read",
  IntegrationActivityCreated: "integration.activity.created",
  /** Emitted by services/sticky-relay: "you have desktop notes you may never
   *  have received — re-fetch". A repair signal, not news; see StickyRefresh. */
  StickyRefresh: "sticky.refresh",
  /** Emitted by services/sticky-svc: this user pinned or unpinned one of their
   *  own tasks, on any device. See StickyPinChanged. */
  StickyPinChanged: "sticky.pin.changed",
  /** A mail landed in someone's Inbox. Signal-only — see MailDelivered. */
  MailDelivered: "mail.delivered",
  PresenceOnline: "presence.online",
  PresenceOffline: "presence.offline",
  PresenceSnapshot: "presence.snapshot",
  UserCreated: "user.created",
  UserRoleChanged: "user.role_changed",
  UserDeactivated: "user.deactivated",
  UserReactivated: "user.reactivated",
  UserRemoved: "user.removed",
  UserSessionStarted: "user.session.started",
  UserSessionEnded: "user.session.ended",
  UserOrgSwitched: "user.org_switched",
  OrgDeleteRequested: "org.delete_requested",
  OrgDeleteCancelled: "org.delete_cancelled",
  OrgDeleted: "org.deleted",
  // ── Calls ──────────────────────────────────────────────────────────────
  // All of these route by `members`, the recipient list messaging-svc computed.
  // That list may legitimately span ORGS for a meeting joined by link, which is
  // why the gateway routes these purely by recipient id and never by org.
  CallScheduled: "call.scheduled",
  CallRing: "call.ring",
  CallParticipantAdded: "call.participant_added",
  /** An ordinary participant left a call that keeps going for everyone else
   *  (contrast CallEnded, the whole call closing). Sent to the live roster AND
   *  the leaver's own other sessions/devices — see messaging-svc's
   *  notifyParticipantLeft, since by the time this fires the leaver's own
   *  roster row is already closed and a plain roster read would miss them. */
  CallParticipantLeft: "call.participant_left",
  CallEnded: "call.ended",
  /** The waiting room is over. Sent to the WHOLE roster, because it means two
   *  things at once: everyone parked in the lobby is now admitted and should
   *  enter, and everyone who has not opened it yet now can. */
  CallStarted: "call.started",
  /** Somebody is in the lobby. The one call event whose `members` is NOT the
   *  roster — it goes only to the people who could start the call. Not a
   *  request for approval: there is nothing to approve, and starting the call
   *  admits everyone waiting at once. */
  CallWaiting: "call.waiting",
  /** Screen sharing started or stopped. `actorId` is the sharer, and is what
   *  tells every other client that a share exists without handing them
   *  anything to stop it with — the stop control is the sharer's alone. */
  CallShareStarted: "call.screenshare_started",
  CallShareStopped: "call.screenshare_stopped",
  InviteCreated: "invite.created",
  PasswordResetRequested: "password.reset.requested",
  EmailVerificationRequested: "email.verification.requested",
} as const;
export type EventTypeName = (typeof EventType)[keyof typeof EventType];

// ── Shared envelope fields ───────────────────────────────────────────────────
const envelope = {
  eventId: z.string().uuid(),
  orgId: z.string().uuid(),
  occurredAt: z.string().datetime(),
};

// ── Messaging events ─────────────────────────────────────────────────────────
/**
 * MessageCreated is the canonical "new message" event. The threading fields
 * (threadId/parentMessageId/isThreadRoot) are OPTIONAL so producers and
 * consumers from before the inbox-threading migration interop cleanly — the
 * canonical consumer-side default is `threadId ← conversationId` when absent.
 */
export const MessageCreated = z.object({
  type: z.literal(EventType.MessageCreated),
  ...envelope,
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  senderId: z.string().uuid(),
  recipientId: z.string().uuid(),
  senderUsername: z.string().optional(),
  senderDisplayName: z.string().optional(),
  body: z.string(),
  clientMsgId: z.string().uuid(),
  /** Inbox thread the message belongs to. Default consumer-side: conversationId. */
  threadId: z.string().uuid().optional(),
  /** UUID of the message this reply is nested under (null/absent = thread root). */
  parentMessageId: z.string().uuid().nullable().optional(),
  /** True when this message is the root of a new thread. */
  isThreadRoot: z.boolean().optional(),
  /** System entries (e.g. a missed call) rather than typed text. Absent = text.
   *  Wire-tolerant so an unknown kind degrades instead of dropping the frame. */
  kind: MessageKindWire.optional(),
  /**
   * Which surface this message's thread belongs to. Only 'mail' threads are
   * Inbox items — the client patches its inbox cache from this event, and
   * without the origin it would re-insert rows the server no longer writes.
   * Absent on pre-0014 producers; treated as 'chat'.
   */
  origin: ThreadOrigin.optional(),
  /** The message this one quotes, if any. */
  replyToId: z.string().uuid().optional(),
  /** True when this message is a copy delivered by forwarding someone else's.
   *  The receiving client labels it — content shown under the forwarder's name
   *  with no marker attributes it to them. */
  isForward: z.boolean().optional(),
  /** Mirrors MessageDTO.forwardPlatform (domain.ts) — set only when kind is
   *  "forward_external", so a live-pushed pill renders the same
   *  "Message forwarded to WhatsApp" line a page-load would. */
  forwardPlatform: z.string().optional(),
});

export const ConversationIgnored = z.object({
  type: z.literal(EventType.ConversationIgnored),
  ...envelope,
  conversationId: z.string().uuid(),
  ignoredBy: z.string().uuid(),
  /** Both members of the 1:1 thread — the gateway pushes to BOTH. */
  members: z.array(z.string().uuid()).length(2).optional(),
  atSeq: z.number().int().nonnegative(),
  /** When the ignore was scoped to a specific thread (post-Inbox migration). */
  threadId: z.string().uuid().optional(),
});

export const ConversationBlocked = z.object({
  type: z.literal(EventType.ConversationBlocked),
  ...envelope,
  conversationId: z.string().uuid(),
  /** Who blocked. The other member renders "You have been blocked". */
  blockedBy: z.string().uuid(),
  /** Both members of the 1:1 — the gateway pushes to BOTH. */
  members: z.array(z.string().uuid()).length(2).optional(),
});

export const ConversationUnblocked = z.object({
  type: z.literal(EventType.ConversationUnblocked),
  ...envelope,
  conversationId: z.string().uuid(),
  unblockedBy: z.string().uuid(),
  members: z.array(z.string().uuid()).length(2).optional(),
});

export const MessageRead = z.object({
  type: z.literal(EventType.MessageRead),
  ...envelope,
  conversationId: z.string().uuid(),
  readerId: z.string().uuid(),
  upToSeq: z.number().int().nonnegative(),
  /** The other participant who should see the read receipt. */
  recipientId: z.string().uuid(),
  /** Optional thread scope so the sender can flip the per-thread Seen badge. */
  threadId: z.string().uuid().optional(),
});

/**
 * MessageDelivered is emitted by messaging-svc when the recipient's gateway
 * confirms a message landed on the wire (via the renderer-side ack frame).
 * Recipients: [senderId]. ws-gateway never produces this — it routes the
 * client ack to messaging-svc which emits through its outbox.
 */
export const MessageDelivered = z.object({
  type: z.literal(EventType.MessageDelivered),
  ...envelope,
  conversationId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  messageId: z.string().uuid(),
  senderId: z.string().uuid(),
  recipientId: z.string().uuid(),
  deliveredAt: z.string().datetime(),
});

/**
 * MessageDismissed is the sender-only "hide from my inbox" signal. Emitted by
 * messaging-svc on POST /messages/{id}/dismiss. Recipients: [dismissedBy] so
 * multi-device sender views stay in sync.
 */
export const MessageDismissed = z.object({
  type: z.literal(EventType.MessageDismissed),
  ...envelope,
  conversationId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  messageId: z.string().uuid(),
  dismissedBy: z.string().uuid(),
});

/**
 * MessageDeleted is "delete for everyone" — the message is a tombstone for BOTH
 * parties now. Routed to `members`, unlike MessageDismissed, which is the
 * sender-only inbox hide and changes nothing for the recipient.
 */
export const MessageDeleted = z.object({
  type: z.literal(EventType.MessageDeleted),
  ...envelope,
  conversationId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  messageId: z.string().uuid(),
  deletedBy: z.string().uuid(),
  members: z.array(z.string().uuid()).optional(),
});

/**
 * MessageReaction says a message's reactions CHANGED, and carries no counts.
 * The tally is per-viewer (`mine` differs between the parties), so a payload of
 * numbers would be right for the actor and wrong for everyone else; each client
 * refetches its own view instead.
 */
export const MessageReaction = z.object({
  type: z.literal(EventType.MessageReaction),
  ...envelope,
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  actorId: z.string().uuid(),
  members: z.array(z.string().uuid()).optional(),
});

/**
 * MessageForwarded is the PROVENANCE signal for a forward of one of this org's
 * messages. Its whole purpose is to reach the ORIGINAL author, so `rootAuthorId`
 * is embedded and the gateway routes on it with no DB lookup (the same trick as
 * ConversationIgnored.members). Routed to [forwardedBy, rootAuthorId] — never to
 * a whole channel, even when `channelId` is set.
 *
 * `delivery` says which of the two forward paths produced it, and consumers MUST
 * word themselves accordingly:
 *
 *   "confirmed"   — an INTERNAL forward. The clone is a real message in a chat
 *                   or channel of this workspace, written in the same
 *                   transaction as this event, so "forwarded to X" is a fact.
 *                   `forwardedMessageId` and one of
 *                   `forwardedTo`/`forwardedToChannelId` are set.
 *   "unconfirmed" — a wa.me DEEP LINK. It hands the message to the operating
 *                   system and ends our visibility: the user may never press
 *                   send. Word it "opened WhatsApp to forward", never
 *                   "forwarded". The pill that renders in the chat is a separate
 *                   ordinary message (kind `forward_external`) riding its own
 *                   message.created; this event is the author's notification.
 */
export const MessageForwarded = z.object({
  type: z.literal(EventType.MessageForwarded),
  ...envelope,
  conversationId: z.string().uuid(),
  /** The original message — the root of the chain. */
  rootMessageId: z.string().uuid(),
  /** Its author — embedded so the gateway routes lookup-free. */
  rootAuthorId: z.string().uuid(),
  /** The message that was forwarded (= rootMessageId at depth 1). */
  parentMessageId: z.string().uuid(),
  /** Who performed the forward. */
  forwardedBy: z.string().uuid(),
  /** The target, in bare E.164 digits. Deep link only. */
  forwardedToExternal: z.string().optional(),
  /** The destination of an INTERNAL forward — a person's chat or a channel,
   *  exactly one of the two. Both absent on the deep-link path, where the
   *  recipient is chosen inside WhatsApp and never reported back. */
  forwardedTo: z.string().uuid().optional(),
  forwardedToChannelId: z.string().uuid().optional(),
  /** The clone delivered to that destination. Absent on the deep-link path,
   *  which creates no message. */
  forwardedMessageId: z.string().uuid().optional(),
  platform: z.string(),
  /** Which path this was — see the note above; the wording of every consumer
   *  depends on it. `.catch` keeps an unrecognised value from failing the whole
   *  envelope; absent is read as confirmed only because pre-deep-link payloads
   *  omitted it. */
  delivery: z.enum(["confirmed", "unconfirmed"]).catch("confirmed").optional(),
  /** The captured contact's display name, when one was captured, so the author
   *  reads a name rather than a bare number. */
  forwardedToName: z.string().optional(),
  /** Set when the forwarded message lived in a channel rather than a DM. */
  channelId: z.string().uuid().optional(),
  /** Hop number (1 = an original forwarded once). */
  depth: z.number().int().positive(),
  /** Truncated body so the author's toast can show what was forwarded. */
  bodyPreview: z.string(),
});

/**
 * A channel message was tombstoned for everyone.
 *
 * `deletedBy` is carried because in a channel it is routinely NOT the author —
 * an owner, channel admin or org_admin moderating someone else's message is the
 * main reason the capability exists.
 */
export const ChannelMessageDeleted = z.object({
  type: z.literal(EventType.ChannelMessageDeleted),
  ...envelope,
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  deletedBy: z.string().uuid(),
  /** Routing only — see ChannelMessageCreated.members. Never read this. */
  members: z.array(z.string().uuid()).optional(),
});

/**
 * Something about one channel message's reactions changed. Carries NO counts,
 * exactly as MessageReaction does: the tally is per-viewer (`mine` differs per
 * member), so numbers computed for the actor would be wrong for everyone else.
 * Each client refetches its own.
 */
export const ChannelMessageReaction = z.object({
  type: z.literal(EventType.ChannelMessageReaction),
  ...envelope,
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  /** Who toggled — used to skip the actor's own echo. */
  actorId: z.string().uuid(),
  /** Routing only — see ChannelMessageCreated.members. Never read this. */
  members: z.array(z.string().uuid()).optional(),
});

/** A message was pinned or unpinned for the whole channel. `pinned: false` is
 *  an unpin — one event type, because every consumer treats it as "this
 *  message's pin state changed, re-render it". */
export const ChannelMessagePinned = z.object({
  type: z.literal(EventType.ChannelMessagePinned),
  ...envelope,
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  pinned: z.boolean(),
  actorId: z.string().uuid(),
  /** Routing only — see ChannelMessageCreated.members. Never read this. */
  members: z.array(z.string().uuid()).optional(),
});

export const ChannelMessageCreated = z.object({
  type: z.literal(EventType.ChannelMessageCreated),
  ...envelope,
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  /**
   * Real name, so a live message renders identically to a refetched one.
   * Optional: older producers don't send it, and clients fall back to
   * `senderUsername` (the email local-part).
   */
  senderDisplayName: z.string().optional(),
  channelName: z.string().optional(),
  body: z.string(),
  /**
   * All channel members — the gateway pushes to each, then DROPS this field.
   *
   * Optional because it is absent on delivery, not because a producer may omit
   * it: messaging-svc always sends it, and routing depends on it. A client must
   * never read it. Sizing a UI off this array would work in a two-person
   * channel and silently show nothing in a real one.
   */
  members: z.array(z.string().uuid()).optional(),
  /** Mirrors MessageCreated.kind. Absent = text; wire-tolerant, same reason. */
  kind: MessageKindWire.optional(),
  /** Mirrors MessageCreated.isForward. */
  isForward: z.boolean().optional(),
  /** Mirrors MessageCreated.forwardPlatform. */
  forwardPlatform: z.string().optional(),
  /** Mirrors MessageCreated.replyToId. */
  replyToId: z.string().uuid().optional(),
  /** Set when sent through a task's "Chat" entry point. Mirrors
   *  ChannelMessageDTO.taskId; absent for an ordinary channel message. */
  taskId: z.string().uuid().nullable().optional(),
});

/**
 * Channel moderation. `members` is the SURVIVING roster and `userId` is the
 * person acted upon — who is usually no longer in it, which is exactly why the
 * two are separate fields. The gateway routes to dedupe(members + userId) so a
 * removed member's own client learns what happened instead of sitting on a
 * channel it can no longer post to.
 */
const channelModeration = {
  ...envelope,
  channelId: z.string().uuid(),
  userId: z.string().uuid(),
  actorId: z.string().uuid().optional(),
  members: z.array(z.string().uuid()).optional(),
};

/**
 * Somebody joined a channel — either added by an existing member, or a
 * self-join of an open channel.
 *
 * Not part of `channelModeration`, and the difference is the point: that shape
 * carries `members` (the surviving roster) because a removal has to reach
 * everyone. This event is emitted ONCE PER ADDED MEMBER, so routing it to the
 * roster would cost added x roster pushes. It goes to `userId` alone — see
 * ./event-routing-spec.ts's recipientsOf, and
 * ws-gateway/internal/contract/contract.go.
 */
export const ChannelMemberJoined = z.object({
  type: z.literal(EventType.ChannelMemberJoined),
  ...envelope,
  channelId: z.string().uuid(),
  /** Who joined. The only recipient. */
  userId: z.string().uuid(),
  /** The channel's name when the join happened, for "You were added to
   *  #general". Optional: producers before it exist, and the client falls back
   *  to the channel list it is about to refetch anyway. */
  channelName: z.string().optional(),
  /** Who performed the add. Equal to `userId` for an open-channel self-join,
   *  which is how a client tells "you were added" from "you joined". Absent
   *  from older producers — treat as unknown, NOT as a self-join. */
  actorId: z.string().uuid().optional(),
  /** Display-name snapshot for the actor, used by notification-svc. */
  actorDisplayName: z.string().optional(),
  /** The joiner's handle. Present for parity with the server event; the client
   *  has no use for it (and it is the email local-part — see lib/userLabel). */
  username: z.string().optional(),
});

export const ChannelMemberRemoved = z.object({
  type: z.literal(EventType.ChannelMemberRemoved),
  ...channelModeration,
});
export const ChannelRoleChanged = z.object({
  type: z.literal(EventType.ChannelRoleChanged),
  ...channelModeration,
});
export const ChannelBlocked = z.object({
  type: z.literal(EventType.ChannelBlocked),
  ...channelModeration,
});
export const ChannelUnblocked = z.object({
  type: z.literal(EventType.ChannelUnblocked),
  ...channelModeration,
});

// ── Task events (per-assignee) ───────────────────────────────────────────────
const taskBase = {
  ...envelope,
  taskId: z.string().uuid(),
  assigneeId: z.string().uuid(),
  senderId: z.string().uuid(),
  statusVersion: z.number().int().nonnegative(),
};

export const TaskAssigned = z.object({
  type: z.literal(EventType.TaskAssigned),
  ...taskBase,
  members: z.array(z.string().uuid()).optional(),
  senderUsername: z.string(),
  title: z.string(),
  description: z.string(),
});

export const TaskWithdrawn = z.object({
  type: z.literal(EventType.TaskWithdrawn),
  ...taskBase,
  members: z.array(z.string().uuid()).optional(),
  assigneeUsername: z.string(),
});

export const TaskAcknowledged = z.object({
  type: z.literal(EventType.TaskAcknowledged),
  ...taskBase,
  assigneeUsername: z.string(),
});

export const TaskCompleted = z.object({
  type: z.literal(EventType.TaskCompleted),
  ...taskBase,
  assigneeUsername: z.string(),
});

export const TaskIgnored = z.object({
  type: z.literal(EventType.TaskIgnored),
  ...taskBase,
  assigneeUsername: z.string(),
});

export const TaskLeft = z.object({
  type: z.literal(EventType.TaskLeft),
  ...taskBase,
  assigneeUsername: z.string(),
});

/** The assignment's deadline passed before it was completed. Fanned out to
 *  [senderId, assigneeId] like the other outcomes: the assignee's card moves from
 *  Allocated to Missed, and the allocator's board refreshes. */
export const TaskMissed = z.object({
  type: z.literal(EventType.TaskMissed),
  ...taskBase,
  assigneeUsername: z.string(),
});

/** Admin hard-delete via task-svc's internal by-title endpoint. INTERNAL-ONLY
 *  (see EventType.TaskDeleted) — carries only taskBase, no username field: it
 *  is never rendered as a toast, only consumed to close a stale projection. */
export const TaskDeleted = z.object({
  type: z.literal(EventType.TaskDeleted),
  ...taskBase,
});

/** Allocator wrote a review on a completed assignment. Signal-only — the review
 *  TEXT (PII) is never on the event; recipients refetch the task. Fanned out to
 *  [senderId, assigneeId] so the assignee sees it live + the sender's other
 *  devices sync. */
export const TaskReviewed = z.object({
  type: z.literal(EventType.TaskReviewed),
  ...taskBase,
  reviewerUsername: z.string(),
});

// ── Notification + Auth events ───────────────────────────────────────────────
/**
 * A nudge from the desktop-note delivery watchdog (services/sticky-relay).
 *
 * A note appears because `task.assigned` arrives over the websocket. When that
 * frame is lost — a reconnect at the wrong moment, or the user offline past the
 * gateway's replay window — the note simply never appears and nothing notices.
 * This says "re-fetch your pins" to one person's clients.
 *
 * Deliberately carries no task content: it is a repair signal, so it should
 * cause a refetch and NOT a toast. Task titles are encrypted at rest and have no
 * business on a channel whose only job is to say "look again".
 */
export const StickyRefresh = z.object({
  type: z.literal(EventType.StickyRefresh),
  eventId: z.string(),
  orgId: z.string(),
  occurredAt: z.string(),
  assigneeId: z.string(),
  /** How many undelivered pins the server believes this user has. */
  pinCount: z.number().int().nonnegative(),
});

/**
 * The user pinned or unpinned a task (services/sticky-svc, PUT/DELETE
 * /sticky/pins/{taskId}). Delivered to every device that user owns, so a pin
 * made on the web moves the desktop note and the other way round.
 *
 * `pinState` is the state AFTER the change. It is a USER choice only — a task
 * finishing closes its pin through the ordinary task.* events and never arrives
 * as UNPINNED. Carries ids and state, no task content.
 */
export const StickyPinChanged = z.object({
  type: z.literal(EventType.StickyPinChanged),
  eventId: z.string(),
  orgId: z.string(),
  occurredAt: z.string(),
  /** The user whose pin changed — and the only recipient. */
  assigneeId: z.string(),
  taskId: z.string(),
  pinState: z.enum(["PINNED", "UNPINNED"]),
});

export const NotificationCreated = z.object({
  type: z.literal(EventType.NotificationCreated),
  ...envelope,
  notificationId: z.string().uuid(),
  recipientId: z.string().uuid(),
  /** Any non-empty kind: an unknown one still reaches the bell (see NotificationDTO.kind)
   *  instead of the whole frame being dropped as unrecognised. */
  kind: z.string().min(1),
  text: z.string(),
  taskId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  callId: z.string().uuid().optional(),
});

export const NotificationRead = z.object({
  type: z.literal(EventType.NotificationRead),
  ...envelope,
  recipientId: z.string().uuid(),
  notificationId: z.string().uuid().optional(),
});

/** Activity recorded by integrations-svc; signal-only, with no message body. */
export const IntegrationActivityCreated = z.object({
  type: z.literal(EventType.IntegrationActivityCreated),
  ...envelope,
  recipientId: z.string().uuid(),
  activityId: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: z.string(),
  kind: z.string(),
  direction: z.enum(["inbound", "outbound"]),
});

/**
 * MailDelivered fires when an email is filed into one or more Inboxes — sent
 * from the composer to a colleague, or received from outside via the inbound
 * ingestion endpoint.
 *
 * Signal-only, and for a stronger reason: the gateway writes every routed
 * event into each recipient's Redis replay outbox,
 * so carrying the subject and body here would put the contents of everybody's
 * mail in Redis. The client's only reaction is to refetch the feed row it
 * already knows how to render, so the id is all it needs.
 *
 * Routed to `members` = every local recipient plus the author, whose other
 * devices need the Sent copy to appear at the same moment.
 *
 * There is deliberately no client-facing sibling for `mail.outbound` (the
 * instruction to email-worker to put a copy on the wire): it carries the mail
 * in plaintext and is never delivered to a socket. See ws-gateway's contract
 * package, which drops it explicitly.
 */
export const MailDelivered = z.object({
  type: z.literal(EventType.MailDelivered),
  ...envelope,
  mailId: z.string().uuid(),
  /** Absent for inbound mail — an external sender has no account here. */
  senderId: z.string().uuid().optional(),
  members: z.array(z.string().uuid()),
});

// ── Presence events (ephemeral; never persisted to the replay outbox) ─────────
/**
 * Presence transitions pushed by ws-gateway. PresenceOnline/Offline fire on the
 * first-connect / last-disconnect edge for a user within an org; PresenceSnapshot
 * is sent once on `hello` with the org's full online set so a (re)connecting
 * client is authoritative immediately. These are EPHEMERAL — the gateway never
 * writes them to the per-user Redis replay outbox, so they can never replay
 * stale online/offline state after a reconnect.
 */
export const PresenceOnline = z.object({
  type: z.literal(EventType.PresenceOnline),
  ...envelope,
  userId: z.string().uuid(),
});

export const PresenceOffline = z.object({
  type: z.literal(EventType.PresenceOffline),
  ...envelope,
  userId: z.string().uuid(),
});

export const PresenceSnapshot = z.object({
  type: z.literal(EventType.PresenceSnapshot),
  ...envelope,
  /** Every user currently online in the caller's org. */
  online: z.array(z.string().uuid()),
});

export const UserCreated = z.object({
  type: z.literal(EventType.UserCreated),
  ...envelope,
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  /**
   * The member's account address. Consumers denormalize it into their
   * `user_projection` so a typed mail recipient resolves to a member (in-app
   * delivery) and so mail a member composes carries their own From: header.
   *
   * Optional because events produced before it was added are still on the
   * topic and must keep parsing; a consumer treats an absent value as "unknown"
   * rather than as an empty address.
   */
  email: z.string().optional(),
});

/**
 * Membership lifecycle, emitted by auth-svc in the same transaction as the
 * change. INTERNAL-ONLY — the gateway's default branch drops every `user.*`
 * event, so none of these reach a client socket. Their job is the
 * `user_projection` mirrors in messaging-svc and task-svc, which until now only
 * ever learned that a user was CREATED and so listed departed members forever.
 *
 * The target learns of their own removal the moment their next `/auth/refresh`
 * fails — auth-svc revokes every refresh family in the same transaction.
 */
const membershipChange = {
  ...envelope,
  userId: z.string().uuid(),
  /** The admin who made the change. Absent on system-initiated changes. */
  actorId: z.string().uuid().optional(),
};

export const UserRoleChanged = z.object({
  type: z.literal(EventType.UserRoleChanged),
  ...membershipChange,
  /** The user's COMPLETE role set after the change, not a delta. */
  roles: z.array(z.string()),
});

export const UserDeactivated = z.object({
  type: z.literal(EventType.UserDeactivated),
  ...membershipChange,
});

export const UserReactivated = z.object({
  type: z.literal(EventType.UserReactivated),
  ...membershipChange,
});

export const UserRemoved = z.object({
  type: z.literal(EventType.UserRemoved),
  ...membershipChange,
});

/**
 * Organization lifecycle. INTERNAL-ONLY — every service that stores org-scoped
 * data consumes `org.deleted`; the gateway's default branch never pushes
 * `org.*` to a browser.
 *
 * Keyed by orgId on `auth.events`, unlike every other event on that topic. They
 * are about the workspace, not a person, and the key is what keeps a delete
 * ordered against that org's other auth events.
 *
 * The pair before the delete exist so the destruction is observable while it is
 * still reversible: an operator watching the stream sees the request and the
 * countdown, not just the aftermath.
 */
export const OrgDeleteRequested = z.object({
  type: z.literal(EventType.OrgDeleteRequested),
  ...envelope,
  /** The admin who asked. Never absent — this action has no system trigger. */
  actorId: z.string().uuid(),
  /** When the grace period expires and the purge becomes eligible to run. */
  purgeAfter: z.string(),
});

export const OrgDeleteCancelled = z.object({
  type: z.literal(EventType.OrgDeleteCancelled),
  ...envelope,
  actorId: z.string().uuid(),
});

/**
 * The org's data is gone from auth-svc and its encryption key has been
 * destroyed. Every consumer must purge its own org-scoped rows.
 *
 * Consumers must be idempotent and must tolerate arriving late or twice: the
 * crypto-shred already happened, so a consumer that is down for an hour finds
 * unreadable ciphertext rather than readable data, and re-running a purge over
 * nothing is a no-op.
 */
export const OrgDeleted = z.object({
  type: z.literal(EventType.OrgDeleted),
  ...envelope,
  /** Kept for the audit trail; the org row itself no longer exists. */
  slug: z.string().optional(),
});

/**
 * Session lifecycle, emitted by auth-svc in the same transaction that issues or
 * revokes the session. INTERNAL-ONLY — consumed by telemetry-svc to anchor the
 * activity timeline; the gateway's default branch never pushes `user.*`.
 *
 * There is deliberately no `user.session.refreshed`: /auth/refresh fires ~4x an
 * hour per device and tells us only "still signed in", which the session row
 * already says.
 */
export const UserSessionStarted = z.object({
  type: z.literal(EventType.UserSessionStarted),
  ...envelope,
  userId: z.string().uuid(),
});

export const UserSessionEnded = z.object({
  type: z.literal(EventType.UserSessionEnded),
  ...envelope,
  userId: z.string().uuid(),
});

/** Switching workspaces ends the activity session in the org being left and
 *  opens one in the org being entered — activity is scoped per membership. */
export const UserOrgSwitched = z.object({
  type: z.literal(EventType.UserOrgSwitched),
  ...envelope,
  userId: z.string().uuid(),
  fromOrgId: z.string().uuid(),
});

/** Internal event consumed by email-worker (never pushed to a client socket). */
export const InviteCreated = z.object({
  type: z.literal(EventType.InviteCreated),
  ...envelope,
  inviteId: z.string().uuid(),
  email: z.string().email(),
  inviteUrl: z.string(),
  orgName: z.string(),
  invitedByUsername: z.string(),
  expiresAt: z.string().datetime(),
});

/** Internal event consumed by email-worker: emails a single-use password-reset
 *  link. Never pushed to a client socket. */
export const PasswordResetRequested = z.object({
  type: z.literal(EventType.PasswordResetRequested),
  ...envelope,
  userId: z.string().uuid(),
  email: z.string().email(),
  resetUrl: z.string(),
  expiresAt: z.string().datetime(),
});

/** Internal event consumed by email-worker: emails a single-use email-
 *  verification link. Never pushed to a client socket. */
export const EmailVerificationRequested = z.object({
  type: z.literal(EventType.EmailVerificationRequested),
  ...envelope,
  userId: z.string().uuid(),
  email: z.string().email(),
  verifyUrl: z.string(),
  expiresAt: z.string().datetime(),
});

// ── Discriminated unions ─────────────────────────────────────────────────────

/** Everything the WS gateway can push to a client. */

// ── Calls ────────────────────────────────────────────────────────────────────

/**
 * One envelope for every call notification, because the gateway routes all four
 * identically — to `members`.
 *
 * These are NOTIFICATIONS ONLY. Media goes to the SFU over its own connection
 * and never touches this path, so nothing here carries SDP or ICE. That split
 * is what lets a meeting notify a participant in another organisation while the
 * rtc.* signaling frames keep refusing to cross an org boundary at all.
 */
/** Fields every call notification carries. Split out so the four discriminants
 *  below stay literal — z.discriminatedUnion needs a literal to switch on. */
const callFields = {
  ...envelope,
  callId: z.string().uuid(),
  kind: z.enum(["DIRECT", "CHANNEL", "MEETING"]),
  channelId: z.string().uuid().optional(),
  title: z.string().optional(),
  media: z.enum(["audio", "video"]).optional(),
  status: z.enum(["SCHEDULED", "LIVE", "ENDED", "CANCELLED"]).optional(),
  scheduledAt: z.string().optional(),
  /** Whoever caused it: the organiser, the person who added someone, the host
   *  who ended or started it, the person who arrived in the lobby, or the one
   *  who started sharing their screen. */
  actorId: z.string().uuid().optional(),
  /** The actor's display name, on call.ring only — what "X added you to a conference
   *  call" is written from. */
  actorName: z.string().optional(),
  /** What is being shared, on the screen-share events only. */
  shareSource: CallShareSource.optional(),
  /** Who should RECEIVE this. Usually the roster — and it may span ORGS for a
   *  meeting joined by link — but not always: call.waiting goes only to the
   *  people who could start the call. */
  members: z.array(z.string().uuid()).optional(),
};

export const CallScheduled = z.object({ type: z.literal(EventType.CallScheduled), ...callFields });
export const CallRing = z.object({ type: z.literal(EventType.CallRing), ...callFields });
export const CallParticipantAdded = z.object({
  type: z.literal(EventType.CallParticipantAdded),
  ...callFields,
});
export const CallParticipantLeft = z.object({
  type: z.literal(EventType.CallParticipantLeft),
  ...callFields,
});
export const CallEnded = z.object({ type: z.literal(EventType.CallEnded), ...callFields });
export const CallStarted = z.object({ type: z.literal(EventType.CallStarted), ...callFields });
export const CallWaiting = z.object({ type: z.literal(EventType.CallWaiting), ...callFields });
export const CallShareStarted = z.object({
  type: z.literal(EventType.CallShareStarted),
  ...callFields,
});
export const CallShareStopped = z.object({
  type: z.literal(EventType.CallShareStopped),
  ...callFields,
});

export type CallScheduled = z.infer<typeof CallScheduled>;
export type CallRing = z.infer<typeof CallRing>;
export type CallParticipantAdded = z.infer<typeof CallParticipantAdded>;
export type CallParticipantLeft = z.infer<typeof CallParticipantLeft>;
export type CallEnded = z.infer<typeof CallEnded>;
export type CallStarted = z.infer<typeof CallStarted>;
export type CallWaiting = z.infer<typeof CallWaiting>;
export type CallShareStarted = z.infer<typeof CallShareStarted>;
export type CallShareStopped = z.infer<typeof CallShareStopped>;
/** Any of them, for handlers that treat them uniformly. */
export type CallLifecycle =
  | CallScheduled
  | CallRing
  | CallParticipantAdded
  | CallParticipantLeft
  | CallEnded
  | CallStarted
  | CallWaiting
  | CallShareStarted
  | CallShareStopped;

export const ServerEvent = z.discriminatedUnion("type", [
  CallScheduled,
  CallRing,
  CallParticipantAdded,
  CallParticipantLeft,
  CallEnded,
  CallStarted,
  CallWaiting,
  CallShareStarted,
  CallShareStopped,
  MessageCreated,
  ConversationIgnored,
  ConversationBlocked,
  ConversationUnblocked,
  MessageRead,
  MessageDelivered,
  MessageDismissed,
  MessageDeleted,
  MessageReaction,
  MessageForwarded,
  ChannelMessageCreated,
  ChannelMessageDeleted,
  ChannelMessageReaction,
  ChannelMessagePinned,
  ChannelMemberJoined,
  ChannelMemberRemoved,
  ChannelRoleChanged,
  ChannelBlocked,
  ChannelUnblocked,
  TaskAssigned,
  TaskWithdrawn,
  TaskAcknowledged,
  TaskCompleted,
  TaskIgnored,
  TaskLeft,
  TaskMissed,
  TaskReviewed,
  NotificationCreated,
  NotificationRead,
  IntegrationActivityCreated,
  StickyRefresh,
  StickyPinChanged,
  MailDelivered,
  PresenceOnline,
  PresenceOffline,
  PresenceSnapshot,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export type MessageCreated = z.infer<typeof MessageCreated>;
export type ConversationIgnored = z.infer<typeof ConversationIgnored>;
export type ConversationBlocked = z.infer<typeof ConversationBlocked>;
export type ConversationUnblocked = z.infer<typeof ConversationUnblocked>;
export type MessageRead = z.infer<typeof MessageRead>;
export type MessageDelivered = z.infer<typeof MessageDelivered>;
export type MessageDismissed = z.infer<typeof MessageDismissed>;
export type MessageDeleted = z.infer<typeof MessageDeleted>;
export type MessageReaction = z.infer<typeof MessageReaction>;
export type MessageForwarded = z.infer<typeof MessageForwarded>;
export type ChannelMessageCreated = z.infer<typeof ChannelMessageCreated>;
export type ChannelMessageDeleted = z.infer<typeof ChannelMessageDeleted>;
export type ChannelMessageReaction = z.infer<typeof ChannelMessageReaction>;
export type ChannelMessagePinned = z.infer<typeof ChannelMessagePinned>;
export type ChannelMemberJoined = z.infer<typeof ChannelMemberJoined>;
export type ChannelMemberRemoved = z.infer<typeof ChannelMemberRemoved>;
export type ChannelRoleChanged = z.infer<typeof ChannelRoleChanged>;
export type ChannelBlocked = z.infer<typeof ChannelBlocked>;
export type ChannelUnblocked = z.infer<typeof ChannelUnblocked>;
export type TaskAssigned = z.infer<typeof TaskAssigned>;
export type TaskWithdrawn = z.infer<typeof TaskWithdrawn>;
export type TaskAcknowledged = z.infer<typeof TaskAcknowledged>;
export type TaskCompleted = z.infer<typeof TaskCompleted>;
export type TaskIgnored = z.infer<typeof TaskIgnored>;
export type TaskLeft = z.infer<typeof TaskLeft>;
export type TaskMissed = z.infer<typeof TaskMissed>;
export type TaskDeleted = z.infer<typeof TaskDeleted>;
export type TaskReviewed = z.infer<typeof TaskReviewed>;
export type NotificationCreated = z.infer<typeof NotificationCreated>;
export type NotificationRead = z.infer<typeof NotificationRead>;
export type IntegrationActivityCreated = z.infer<typeof IntegrationActivityCreated>;
export type StickyRefresh = z.infer<typeof StickyRefresh>;
export type StickyPinChanged = z.infer<typeof StickyPinChanged>;
export type MailDelivered = z.infer<typeof MailDelivered>;
export type PresenceOnline = z.infer<typeof PresenceOnline>;
export type PresenceOffline = z.infer<typeof PresenceOffline>;
export type PresenceSnapshot = z.infer<typeof PresenceSnapshot>;
export type UserCreated = z.infer<typeof UserCreated>;
export type UserRoleChanged = z.infer<typeof UserRoleChanged>;
export type UserDeactivated = z.infer<typeof UserDeactivated>;
export type UserReactivated = z.infer<typeof UserReactivated>;
export type UserRemoved = z.infer<typeof UserRemoved>;
export type UserSessionStarted = z.infer<typeof UserSessionStarted>;
export type UserSessionEnded = z.infer<typeof UserSessionEnded>;
export type UserOrgSwitched = z.infer<typeof UserOrgSwitched>;
export type OrgDeleteRequested = z.infer<typeof OrgDeleteRequested>;
export type OrgDeleteCancelled = z.infer<typeof OrgDeleteCancelled>;
export type OrgDeleted = z.infer<typeof OrgDeleted>;
export type InviteCreated = z.infer<typeof InviteCreated>;
export type PasswordResetRequested = z.infer<typeof PasswordResetRequested>;
export type EmailVerificationRequested = z.infer<typeof EmailVerificationRequested>;

// ── Client → server WS control frames ────────────────────────────────────────
/**
 * WebRTC signaling frames are EPHEMERAL — never persisted to the Redis ZSET
 * replay outbox, never produced to Kafka. Routed peer-to-peer by ws-gateway.
 * fromUserId is stamped by the gateway from the verified JWT; clients MUST NOT
 * supply it. Frame body for rtc.offer/answer is the JSON-stringified SDP; for
 * rtc.ice it is the JSON-stringified ICE candidate.
 */
const RtcOfferClient = z.object({
  type: z.literal("rtc.offer"),
  toUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  sdp: z.string(),
});
const RtcAnswerClient = z.object({
  type: z.literal("rtc.answer"),
  toUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  sdp: z.string(),
  resumeFromChunkIndex: z.number().int().nonnegative().optional(),
});
const RtcIceClient = z.object({
  type: z.literal("rtc.ice"),
  toUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  candidate: z.string(),
});
const RtcCancelClient = z.object({
  type: z.literal("rtc.cancel"),
  toUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  reason: z.enum(["sender_left", "receiver_declined", "ice_failed", "timeout"]).optional(),
});

/**
 * Delivery acks. Renderer batches one frame per 500 ms per thread to amplify
 * the read-side savings without per-message volume. ws-gateway forwards each
 * messageId to messaging-svc which emits the canonical MessageDelivered event
 * through its outbox — preserves the outbox-then-Kafka invariant.
 */
const MessageAckClient = z.object({
  type: z.literal("message.ack"),
  messageIds: z.array(z.string().uuid()).min(1).max(64),
});

/** Typing indicator — ephemeral 1:1 hint routed like rtc.* (never persisted or
 *  replayed). `start` on keystroke, `stop` on send/blur; the peer auto-expires it
 *  after a few seconds if no `stop` arrives. */
const TypingClient = z.object({
  type: z.literal("typing"),
  toUserId: z.string().uuid(),
  conversationId: z.string().uuid(),
  state: z.enum(["start", "stop"]),
});

// Call lifecycle — ephemeral 1:1 ring/accept/decline/cancel/end. The media SDP
// and ICE candidates reuse the rtc.offer/answer/ice frames with offerId ===
// callId; `media` is set on invite (audio = voice call, video = video call).
const CallInviteClient = z.object({ type: z.literal("call.invite"), toUserId: z.string().uuid(), callId: z.string().uuid(), media: z.enum(["audio", "video"]) });
const CallAcceptClient = z.object({ type: z.literal("call.accept"), toUserId: z.string().uuid(), callId: z.string().uuid() });
const CallDeclineClient = z.object({ type: z.literal("call.decline"), toUserId: z.string().uuid(), callId: z.string().uuid() });
const CallCancelClient = z.object({ type: z.literal("call.cancel"), toUserId: z.string().uuid(), callId: z.string().uuid() });
const CallEndClient = z.object({ type: z.literal("call.end"), toUserId: z.string().uuid(), callId: z.string().uuid() });

export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), lastSeenSeq: z.number().int().optional() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("auth.renew"), token: z.string() }),
  z.object({ type: z.literal("subscribe"), topics: z.array(z.string()) }),
  RtcOfferClient,
  RtcAnswerClient,
  RtcIceClient,
  RtcCancelClient,
  MessageAckClient,
  TypingClient,
  CallInviteClient,
  CallAcceptClient,
  CallDeclineClient,
  CallCancelClient,
  CallEndClient,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// Server-side counterparts of the rtc.* frames: the gateway stamps fromUserId
// and forwards (toUserId is dropped — the recipient knows it's them).
const RtcOfferServer = z.object({
  type: z.literal("rtc.offer"),
  fromUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  sdp: z.string(),
});
const RtcAnswerServer = z.object({
  type: z.literal("rtc.answer"),
  fromUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  sdp: z.string(),
  resumeFromChunkIndex: z.number().int().nonnegative().optional(),
});
const RtcIceServer = z.object({
  type: z.literal("rtc.ice"),
  fromUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  candidate: z.string(),
});
const RtcCancelServer = z.object({
  type: z.literal("rtc.cancel"),
  fromUserId: z.string().uuid(),
  offerId: z.string().uuid(),
  reason: z.enum(["sender_left", "receiver_declined", "ice_failed", "timeout"]).optional(),
});
// Typing indicator pushed to the peer (gateway stamps fromUserId).
const TypingServer = z.object({
  type: z.literal("typing"),
  fromUserId: z.string().uuid(),
  conversationId: z.string().uuid(),
  state: z.enum(["start", "stop"]),
});
// Call lifecycle pushed to the peer (gateway stamps fromUserId). `fromName` is
// the caller's name, also stamped gateway-side from the JWT claims so the ring
// screen can name the caller; optional so an older gateway still validates.
const CallInviteServer = z.object({ type: z.literal("call.invite"), fromUserId: z.string().uuid(), callId: z.string().uuid(), media: z.enum(["audio", "video"]), fromName: z.string().optional() });
const CallAcceptServer = z.object({ type: z.literal("call.accept"), fromUserId: z.string().uuid(), callId: z.string().uuid() });
const CallDeclineServer = z.object({ type: z.literal("call.decline"), fromUserId: z.string().uuid(), callId: z.string().uuid() });
const CallCancelServer = z.object({ type: z.literal("call.cancel"), fromUserId: z.string().uuid(), callId: z.string().uuid() });
const CallEndServer = z.object({ type: z.literal("call.end"), fromUserId: z.string().uuid(), callId: z.string().uuid() });

export const ControlFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("token.refresh.required") }),
  z.object({ type: z.literal("ready"), userId: z.string(), orgId: z.string() }),
  /**
   * Marks the end of the connect-time catch-up burst. Everything between
   * `ready` and this frame ALREADY HAPPENED — the client must apply it to its
   * caches but must not announce it, or every launch re-toasts the last 200
   * events. An explicit marker rather than a timestamp comparison because
   * `occurredAt` is server time and the client's clock may disagree with it by
   * more than the window would allow.
   */
  z.object({ type: z.literal("replay.done") }),
  // WebRTC control frames pushed by the gateway. Treated as control (not
  // ServerEvent) so the WS dedup LRU / replay outbox does NOT see them.
  RtcOfferServer,
  RtcAnswerServer,
  RtcIceServer,
  RtcCancelServer,
  TypingServer,
  CallInviteServer,
  CallAcceptServer,
  CallDeclineServer,
  CallCancelServer,
  CallEndServer,
  z.object({ type: z.literal("rtc.peer.unreachable"), offerId: z.string().uuid(), reason: z.string() }),
  z.object({ type: z.literal("rtc.rate_limited"), retryAfterMs: z.number().int().positive() }),
]);
export type ControlFrame = z.infer<typeof ControlFrame>;

/** Discriminant set for rtc.* control frames so the WS client can route them
 *  to the WebRTC layer separately from domain ServerEvents. */
export const RTC_CONTROL_TYPES = new Set<string>([
  "rtc.offer",
  "rtc.answer",
  "rtc.ice",
  "rtc.cancel",
  "rtc.peer.unreachable",
  "rtc.rate_limited",
]);

/** call.* lifecycle control frames so the WS client can route them to the call
 *  layer (distinct from rtc.* media signaling, which the call layer also owns). */
export const CALL_CONTROL_TYPES = new Set<string>([
  "call.invite",
  "call.accept",
  "call.decline",
  "call.cancel",
  "call.end",
]);
