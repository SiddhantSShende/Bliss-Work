/** CANONICAL EVENT CONTRACT (zod) — single source of truth for Kafka events +
 *  server→client WS frames; Go/Python structs mirror it. Conventions: `orgId`
 *  tenant, `eventId` (UUIDv7) dedup, discrete per-transition types, JSON. */
import { z } from "zod";

// ── Kafka topics ────────────────────────────────────────────────────────────
export const Topics = {
  Messaging: "messaging.events.v1", // key = conversationId
  Task: "task.events.v1", // key = taskId
  Notification: "notification.events.v1", // key = recipientId
  Auth: "auth.events", // key = userId
} as const;
export type TopicName = (typeof Topics)[keyof typeof Topics];

// ── Event type discriminants ─────────────────────────────────────────────────
export const EventType = {
  MessageCreated: "message.created",
  ConversationIgnored: "conversation.ignored",
  MessageRead: "message.read",
  MessageDelivered: "message.delivered",
  MessageDismissed: "message.dismissed",
  ChannelMessageCreated: "channel.message.created",
  TaskAssigned: "task.assigned",
  TaskAcknowledged: "task.acknowledged",
  TaskCompleted: "task.completed",
  TaskIgnored: "task.ignored",
  TaskLeft: "task.left",
  NotificationCreated: "notification.created",
  PresenceOnline: "presence.online",
  PresenceOffline: "presence.offline",
  PresenceSnapshot: "presence.snapshot",
  UserCreated: "user.created",
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
  body: z.string(),
  clientMsgId: z.string().uuid(),
  /** Inbox thread the message belongs to. Default consumer-side: conversationId. */
  threadId: z.string().uuid().optional(),
  /** UUID of the message this reply is nested under (null/absent = thread root). */
  parentMessageId: z.string().uuid().nullable().optional(),
  /** True when this message is the root of a new thread. */
  isThreadRoot: z.boolean().optional(),
});

export const ConversationIgnored = z.object({
  type: z.literal(EventType.ConversationIgnored),
  ...envelope,
  conversationId: z.string().uuid(),
  ignoredBy: z.string().uuid(),
  /** Both members of the 1:1 thread — the gateway pushes to BOTH. */
  members: z.array(z.string().uuid()).length(2),
  atSeq: z.number().int().nonnegative(),
  /** When the ignore was scoped to a specific thread (post-Inbox migration). */
  threadId: z.string().uuid().optional(),
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

export const ChannelMessageCreated = z.object({
  type: z.literal(EventType.ChannelMessageCreated),
  ...envelope,
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  body: z.string(),
  /** All channel members — the gateway pushes to each. */
  members: z.array(z.string().uuid()),
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
  senderUsername: z.string(),
  title: z.string(),
  description: z.string(),
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

// ── Notification + Auth events ───────────────────────────────────────────────
export const NotificationCreated = z.object({
  type: z.literal(EventType.NotificationCreated),
  ...envelope,
  notificationId: z.string().uuid(),
  recipientId: z.string().uuid(),
  kind: z.enum(["TASK_ACKNOWLEDGED", "TASK_COMPLETED", "TASK_IGNORED", "TASK_LEFT"]),
  text: z.string(),
  taskId: z.string().uuid().optional(),
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
export const ServerEvent = z.discriminatedUnion("type", [
  MessageCreated,
  ConversationIgnored,
  MessageRead,
  MessageDelivered,
  MessageDismissed,
  ChannelMessageCreated,
  TaskAssigned,
  TaskAcknowledged,
  TaskCompleted,
  TaskIgnored,
  TaskLeft,
  NotificationCreated,
  PresenceOnline,
  PresenceOffline,
  PresenceSnapshot,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Every domain event on the bus (superset of ServerEvent + internal-only). */
export const DomainEvent = z.discriminatedUnion("type", [
  MessageCreated,
  ConversationIgnored,
  MessageRead,
  MessageDelivered,
  MessageDismissed,
  ChannelMessageCreated,
  TaskAssigned,
  TaskAcknowledged,
  TaskCompleted,
  TaskIgnored,
  TaskLeft,
  NotificationCreated,
  UserCreated,
  InviteCreated,
  PasswordResetRequested,
  EmailVerificationRequested,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;

export type MessageCreated = z.infer<typeof MessageCreated>;
export type ConversationIgnored = z.infer<typeof ConversationIgnored>;
export type MessageRead = z.infer<typeof MessageRead>;
export type MessageDelivered = z.infer<typeof MessageDelivered>;
export type MessageDismissed = z.infer<typeof MessageDismissed>;
export type ChannelMessageCreated = z.infer<typeof ChannelMessageCreated>;
export type TaskAssigned = z.infer<typeof TaskAssigned>;
export type TaskAcknowledged = z.infer<typeof TaskAcknowledged>;
export type TaskCompleted = z.infer<typeof TaskCompleted>;
export type TaskIgnored = z.infer<typeof TaskIgnored>;
export type TaskLeft = z.infer<typeof TaskLeft>;
export type NotificationCreated = z.infer<typeof NotificationCreated>;
export type PresenceOnline = z.infer<typeof PresenceOnline>;
export type PresenceOffline = z.infer<typeof PresenceOffline>;
export type PresenceSnapshot = z.infer<typeof PresenceSnapshot>;
export type UserCreated = z.infer<typeof UserCreated>;
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
// Call lifecycle pushed to the peer (gateway stamps fromUserId).
const CallInviteServer = z.object({ type: z.literal("call.invite"), fromUserId: z.string().uuid(), callId: z.string().uuid(), media: z.enum(["audio", "video"]) });
const CallAcceptServer = z.object({ type: z.literal("call.accept"), fromUserId: z.string().uuid(), callId: z.string().uuid() });
const CallDeclineServer = z.object({ type: z.literal("call.decline"), fromUserId: z.string().uuid(), callId: z.string().uuid() });
const CallCancelServer = z.object({ type: z.literal("call.cancel"), fromUserId: z.string().uuid(), callId: z.string().uuid() });
const CallEndServer = z.object({ type: z.literal("call.end"), fromUserId: z.string().uuid(), callId: z.string().uuid() });

export const ControlFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("token.refresh.required") }),
  z.object({ type: z.literal("ready"), userId: z.string(), orgId: z.string() }),
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

/**
 * Routing helper — given a domain event, which user IDs should receive it over
 * their live socket? The gateway uses this in consume-all-and-filter mode.
 */
export function recipientsOf(e: DomainEvent): string[] {
  switch (e.type) {
    case EventType.MessageCreated:
      return [e.recipientId, e.senderId];
    case EventType.ConversationIgnored:
      return e.members;
    case EventType.MessageRead:
      return [e.recipientId];
    case EventType.MessageDelivered:
      // Sender-only echo so the per-message Delivered badge flips.
      return [e.senderId];
    case EventType.MessageDismissed:
      // Multi-device sync for the sender who dismissed; never to the peer.
      return [e.dismissedBy];
    case EventType.ChannelMessageCreated:
      return e.members;
    case EventType.TaskAssigned:
      return [e.assigneeId];
    case EventType.TaskAcknowledged:
    case EventType.TaskCompleted:
      // own-echo to assignee (updates their sticky widget) + notify sender
      return [e.senderId, e.assigneeId];
    case EventType.TaskIgnored:
    case EventType.TaskLeft:
      return [e.senderId, e.assigneeId];
    case EventType.NotificationCreated:
      return [e.recipientId];
    case EventType.UserCreated:
    case EventType.InviteCreated:
    case EventType.PasswordResetRequested:
    case EventType.EmailVerificationRequested:
      return []; // internal-only, never pushed to a socket
    default:
      return [];
  }
}

/**
 * Loop guard: ws-gateway must NEVER generate a delivery ack for any of these
 * event types. Without this, message.delivered → ack → message.delivered would
 * fan-in cycle. Phase 5 gateway code consults this set before forwarding to
 * messaging-svc's internal /delivered endpoint.
 */
export const NO_DELIVERY_ACK_FOR = new Set<string>([
  EventType.MessageDelivered,
  EventType.MessageRead,
  EventType.MessageDismissed,
  EventType.ConversationIgnored,
  EventType.TaskAcknowledged,
  EventType.TaskCompleted,
  EventType.TaskIgnored,
  EventType.TaskLeft,
  EventType.NotificationCreated,
]);
