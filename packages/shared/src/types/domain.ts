/** Domain DTOs shared by the API client, web app, and Electron renderer. */
import { z } from "zod";

// ── Auth / org / directory ───────────────────────────────────────────────────
export const Role = z.enum(["org_admin", "member"]);
export type Role = z.infer<typeof Role>;

export const UserDTO = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().email(),
  roles: z.array(Role),
  /** Whether the user has confirmed their email. Optional for forward-compat
   *  with pre-verification responses; UI treats only `=== false` as unverified. */
  emailVerified: z.boolean().optional(),
});
export type UserDTO = z.infer<typeof UserDTO>;

export const SessionDTO = z.object({
  accessToken: z.string(),
  user: UserDTO,
  expiresIn: z.number().int(),
});
export type SessionDTO = z.infer<typeof SessionDTO>;

/** A pending/processed org invite (admin view). */
export const InviteDTO = z.object({
  id: z.string(),
  email: z.string().email(),
  role: Role,
  status: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type InviteDTO = z.infer<typeof InviteDTO>;

// ── Communication ─────────────────────────────────────────────────────────────
/**
 * MessageStatus is the sender-side per-message state shown next to a bubble:
 * PENDING   — optimistic; no server id yet (network in flight)
 * SENT      — messaging-svc returned 201
 * DELIVERED — recipient's gateway wrote bytes to a live socket (MessageDelivered)
 * SEEN      — recipient read at least up to this message's seq (MessageRead)
 */
export const MessageStatus = z.enum(["PENDING", "SENT", "DELIVERED", "SEEN"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const MessageDTO = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
  isThreadRoot: z.boolean().optional(),
  seq: z.number().int(),
  senderId: z.string().uuid(),
  body: z.string(),
  createdAt: z.string(),
  /** Set only on the sender's own bubbles. */
  status: MessageStatus.optional(),
  /** Set when the sender has dismissed (sender_dismissed_at IS NOT NULL). */
  dismissedBySender: z.boolean().optional(),
});
export type MessageDTO = z.infer<typeof MessageDTO>;

/**
 * @deprecated In the Inbox model use InboxItemDTO + ThreadDTO. ConversationDTO
 * is now the peer-drill-down view at /chats only.
 */
export const ConversationDTO = z.object({
  id: z.string().uuid(),
  peerId: z.string().uuid(),
  peerUsername: z.string(),
  lastMessage: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  unread: z.number().int(),
  /** The caller blocked the peer ("You blocked this user"). */
  blockedByMe: z.boolean().default(false),
  /** The peer blocked the caller ("You have been blocked"). */
  blockedByPeer: z.boolean().default(false),
});
export type ConversationDTO = z.infer<typeof ConversationDTO>;

// ── Inbox (unified message threads + tasks) ──────────────────────────────────
export const InboxItemKind = z.enum(["THREAD", "TASK"]);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

/**
 * Single row in the unified inbox feed. A THREAD row points to a message
 * thread; a TASK row points to a task assigned to this user. Status/preview
 * differ per kind.
 */
export const InboxItemDTO = z.object({
  ownerUserId: z.string().uuid(),
  itemKind: InboxItemKind,
  /** threadId when itemKind=THREAD; taskId when itemKind=TASK. */
  refId: z.string().uuid(),
  peerUserId: z.string().uuid().nullable(),
  peerUsername: z.string().nullable(),
  preview: z.string(),
  /** ISO8601 — primary cursor field, also the visible time-ago. */
  lastEventAt: z.string(),
  unreadCount: z.number().int().nonnegative(),
  /** Tiny chip surface: 'SENT'|'DELIVERED'|'SEEN' for threads (sender side);
   *  'SENT'|'ACKNOWLEDGED'|'COMPLETED'|'IGNORED'|'LEFT' for tasks. */
  statusBadge: z.string().nullable(),
  hiddenForOwner: z.boolean(),
  deletedForOwner: z.boolean(),
});
export type InboxItemDTO = z.infer<typeof InboxItemDTO>;

/** A keyset-paginated page of the unified inbox. cursor encodes
 *  (lastEventAt, refId) — the next call passes it back verbatim. */
export const InboxPageDTO = z.object({
  items: z.array(InboxItemDTO),
  nextCursor: z.string().nullable(),
});
export type InboxPageDTO = z.infer<typeof InboxPageDTO>;

/**
 * One counterparty in the inbox People sidebar: a distinct user the caller has
 * exchanged messages/tasks with, plus the rollups that drive ordering (newest
 * activity first) and the unread badge. Returned by GET /inbox/peers.
 */
export const InboxPeerDTO = z.object({
  peerId: z.string().uuid(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  lastEventAt: z.string(),
  unreadCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
});
export type InboxPeerDTO = z.infer<typeof InboxPeerDTO>;

/** Detailed thread header used at /inbox/thread/:id. */
export const ThreadDTO = z.object({
  threadId: z.string().uuid(),
  conversationId: z.string().uuid(),
  rootMessageId: z.string().uuid(),
  peerId: z.string().uuid(),
  peerUsername: z.string(),
  subjectPreview: z.string(),
  lastEventAt: z.string(),
  lastMessageSeq: z.number().int(),
  unreadCount: z.number().int().nonnegative(),
  myLastReadSeq: z.number().int(),
});
export type ThreadDTO = z.infer<typeof ThreadDTO>;

// ── Tasks ──────────────────────────────────────────────────────────────────────
export const AssigneeStatus = z.enum([
  "SENT",
  "IGNORED",
  "ACKNOWLEDGED",
  "COMPLETED",
  "LEFT",
]);
export type AssigneeStatus = z.infer<typeof AssigneeStatus>;

export const TaskAction = z.enum(["ACKNOWLEDGE", "IGNORE", "COMPLETE", "LEAVE"]);
export type TaskAction = z.infer<typeof TaskAction>;

/** Star rating on a review — 1..5, or null when the allocator left only text. */
const ReviewRating = z.number().int().min(1).max(5).nullable().optional();

/** A task as seen by an assignee (inbox + sticky widget). Carries the full
 *  per-assignment timeline + the review the assignee received. */
export const StickyTaskDTO = z.object({
  taskId: z.string().uuid(),
  orgId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  myStatus: AssigneeStatus,
  actions: z.array(TaskAction),
  statusVersion: z.number().int(),
  assignedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  completedAt: z.string().nullable().optional(),
  ignoredAt: z.string().nullable().optional(),
  leftAt: z.string().nullable().optional(),
  reviewedAt: z.string().nullable().optional(),
  review: z.string().nullable().optional(),
  reviewRating: ReviewRating,
});
export type StickyTaskDTO = z.infer<typeof StickyTaskDTO>;

/** A task as seen by its creator (sent tab) with per-assignee rollup. Each
 *  assignee row carries its timeline milestones + the review the sender left. */
export const SentTaskDTO = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  createdAt: z.string(),
  assignees: z.array(
    z.object({
      assigneeId: z.string().uuid(),
      assigneeUsername: z.string(),
      status: AssigneeStatus,
      assignedAt: z.string().nullable().optional(),
      acknowledgedAt: z.string().nullable().optional(),
      completedAt: z.string().nullable().optional(),
      ignoredAt: z.string().nullable().optional(),
      leftAt: z.string().nullable().optional(),
      reviewedAt: z.string().nullable().optional(),
      review: z.string().nullable().optional(),
      reviewRating: ReviewRating,
    }),
  ),
});
export type SentTaskDTO = z.infer<typeof SentTaskDTO>;

/** Response from POST …/review — the persisted review. */
export const ReviewResponse = z.object({
  reviewedAt: z.string(),
  review: z.string(),
  reviewRating: ReviewRating,
});
export type ReviewResponse = z.infer<typeof ReviewResponse>;

/** One row of the task export — a single (task, assignee) assignment with its
 *  full timeline + review. Emails are joined client-side from the directory. */
export const TaskExportRow = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  allocatedById: z.string().uuid(),
  allocatedByUsername: z.string(),
  allocatedToId: z.string().uuid(),
  allocatedToUsername: z.string(),
  status: AssigneeStatus,
  allocatedAt: z.string(),
  acknowledgedAt: z.string().nullable().optional(),
  ignoredAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  leftAt: z.string().nullable().optional(),
  /** Whole-turnaround seconds (completed − allocated); null unless completed. */
  timeTakenSeconds: z.number().int().nullable().optional(),
  reviewedAt: z.string().nullable().optional(),
  review: z.string().nullable().optional(),
  reviewRating: ReviewRating,
});
export type TaskExportRow = z.infer<typeof TaskExportRow>;

// ── Notifications ────────────────────────────────────────────────────────────
export const NotificationDTO = z.object({
  id: z.string().uuid(),
  kind: z.enum(["TASK_ACKNOWLEDGED", "TASK_COMPLETED", "TASK_IGNORED", "TASK_LEFT"]),
  text: z.string(),
  taskId: z.string().uuid().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationDTO = z.infer<typeof NotificationDTO>;

// ── Channels (group chat / teams) ───────────────────────────────────────────────
export const ChannelDTO = z.object({
  id: z.string().uuid(),
  name: z.string(),
  memberCount: z.number().int(),
  lastMessage: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  /** Locked channels are invite-only; open channels accept self-join via
   *  `POST /channels/{id}/join`. Default false (open) for back-compat. */
  isLocked: z.boolean().default(false),
  /** Whether the caller is currently a member. True for /channels (the
   *  caller's own channels) and false for /channels/open (the directory of
   *  joinable channels). */
  iAmMember: z.boolean().default(true),
});
export type ChannelDTO = z.infer<typeof ChannelDTO>;

export const ChannelMessageDTO = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  seq: z.number().int(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type ChannelMessageDTO = z.infer<typeof ChannelMessageDTO>;

/** Which actions are valid for a given assignee status. */
export function actionsFor(status: AssigneeStatus): TaskAction[] {
  switch (status) {
    case "SENT":
      return ["ACKNOWLEDGE", "IGNORE"];
    case "ACKNOWLEDGED":
      return ["COMPLETE", "LEAVE"];
    default:
      return [];
  }
}
