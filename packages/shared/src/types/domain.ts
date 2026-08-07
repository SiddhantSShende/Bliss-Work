/** Domain DTOs shared by the API client, web app, and Electron renderer. */
import { z } from "zod";

// ── Auth / org / directory ───────────────────────────────────────────────────
export const Role = z.enum(["org_admin", "member"]);
export type Role = z.infer<typeof Role>;

export const UserDTO = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  /** Display name of the active org (for the workspace switcher label). */
  orgName: z.string().default(""),
  username: z.string(),
  displayName: z.string(),
  email: z.string().email(),
  roles: z.array(Role),
  /** Whether the user has confirmed their email. Optional for forward-compat
   *  with pre-verification responses; UI treats only `=== false` as unverified. */
  emailVerified: z.boolean().optional(),
  /** Org subscription plan (entitlements). 'enterprise' unlocks External
   *  Integrations + forward-tracking. Defaults 'free' for older responses. */
  plan: z.string().default("free"),
});
export type UserDTO = z.infer<typeof UserDTO>;

/** One organization the signed-in identity belongs to — for the org switcher.
 *  A single email/password can span multiple orgs; `active` marks the current one. */
export const OrgMembershipDTO = z.object({
  orgId: z.string().uuid(),
  orgName: z.string(),
  roles: z.array(Role),
  active: z.boolean().default(false),
});
export type OrgMembershipDTO = z.infer<typeof OrgMembershipDTO>;

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

/**
 * What a message IS, as opposed to what it says. "text" is something a person
 * typed; "call_missed" is a system entry the app writes when a call rings out,
 * rendered as a centered notice rather than a chat bubble. Absent on the wire
 * for ordinary text, so old payloads parse unchanged.
 */
export const MessageKind = z.enum(["text", "call_missed"]);
export type MessageKind = z.infer<typeof MessageKind>;

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
  /** System entries (e.g. a missed call). Absent = ordinary text. */
  kind: MessageKind.optional(),
  /** Set only on the sender's own bubbles. */
  status: MessageStatus.optional(),
  /** Set when the sender has dismissed (sender_dismissed_at IS NOT NULL). */
  dismissedBySender: z.boolean().optional(),
});
export type MessageDTO = z.infer<typeof MessageDTO>;

/**
 * One hop of a forward chain, returned by GET /messages/{id}/forwards. The
 * ORIGINAL author renders these as the downstream forward tree: who forwarded
 * their message, to whom, on which platform, and when. `parentMessageId` + `depth`
 * reconstruct the tree. `forwardedTo` is set for internal (Bliss-Work) recipients;
 * `forwardedToExternal` for outbound-to-external forwards.
 */
export const ForwardEdgeDTO = z.object({
  id: z.string().uuid(),
  rootMessageId: z.string().uuid(),
  rootAuthorId: z.string().uuid(),
  parentMessageId: z.string().uuid(),
  forwardedMessageId: z.string().uuid().nullable().optional(),
  forwardedBy: z.string().uuid(),
  forwardedTo: z.string().uuid().nullable().optional(),
  forwardedToExternal: z.string().nullable().optional(),
  platform: z.string(),
  depth: z.number().int().positive(),
  createdAt: z.string(),
});
export type ForwardEdgeDTO = z.infer<typeof ForwardEdgeDTO>;

/** One of the caller's original messages that has been forwarded — the row shown
 *  in the "who forwarded my messages" feed. Expand a row to fetch its full tree
 *  (ForwardEdgeDTO[]) via GET /messages/{rootMessageId}/forwards. */
export const ForwardActivityDTO = z.object({
  rootMessageId: z.string().uuid(),
  preview: z.string(),
  forwardCount: z.number().int().nonnegative(),
  lastForwardedAt: z.string(),
});
export type ForwardActivityDTO = z.infer<typeof ForwardActivityDTO>;

// ── External Integrations ────────────────────────────────────────────────────
export const IntegrationProvider = z.enum(["slack", "whatsapp", "gmail", "outlook", "teams"]);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

export const IntegrationStatus = z.enum(["pending", "connected", "error", "revoked"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** A connected external account. NEVER carries tokens — those stay encrypted
 *  server-side and are never serialized to the client. */
export const IntegrationConnectionDTO = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  status: IntegrationStatus,
  /** 'user' = per-user account (Gmail); 'org' = workspace-wide (Slack bot). */
  scopeKind: z.enum(["user", "org"]),
  displayLabel: z.string(),
  scopes: z.array(z.string()),
  lastError: z.string().nullable().optional(),
  /** Per-connection webhook URL to paste into the provider's dashboard. Only
   *  set for providers that call us (Slack, WhatsApp). Not a secret on its own —
   *  the provider's HMAC signature still authenticates every delivery. */
  webhookUrl: z.string().nullable().optional(),
  /** WhatsApp only: the `hub.verify_token` to paste into Meta alongside the URL.
   *  Generated server-side; the admin can't re-derive it, so it's readable. */
  webhookVerifyToken: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntegrationConnectionDTO = z.infer<typeof IntegrationConnectionDTO>;

/** One OAuth vendor's app setup for this workspace.
 *
 *  Integrations are user-driven: each org registers its OWN Google Cloud / Entra
 *  app rather than authorizing a central Bliss-Work one. The client secret is
 *  write-only — it is never returned by the API, at any point. */
export const AppCredentialDTO = z.object({
  vendor: z.enum(["google", "microsoft"]),
  configured: z.boolean(),
  /** 'org' = this workspace's own app; 'server' = the deployment-wide fallback. */
  source: z.enum(["org", "server"]).nullable().optional(),
  /** Not secret — it travels in the authorize URL the browser follows. */
  clientId: z.string().default(""),
  tenant: z.string().nullable().optional(),
  pubsubTopic: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  /** Which providers these credentials unlock (microsoft → outlook + teams). */
  providers: z.array(z.string()).default([]),
  /** The exact URIs to register in the vendor's console. Mismatch here is the
   *  most common OAuth setup failure, so the server hands over literal strings. */
  redirectUris: z.array(z.string()).default([]),
});
export type AppCredentialDTO = z.infer<typeof AppCredentialDTO>;

/** Result of starting a connect flow. OAuth providers return an authorizeUrl to
 *  redirect the user to; token-paste providers return the created connection. */
export const ConnectStartDTO = z.object({
  authorizeUrl: z.string().nullable().optional(),
  connection: IntegrationConnectionDTO.nullable().optional(),
});
export type ConnectStartDTO = z.infer<typeof ConnectStartDTO>;

/** What the browser needs to open Meta's WhatsApp Business signup popup.
 *
 *  `appId` / `configId` are NOT secrets — they travel in the popup URL the
 *  user's own browser follows. `available` is false until this deployment is
 *  configured as a Meta Tech Provider, which is what lets the UI say so plainly
 *  rather than opening a popup that dies on Meta's side. */
export const EmbeddedSignupDTO = z.object({
  available: z.boolean(),
  appId: z.string().default(""),
  configId: z.string().default(""),
  graphVersion: z.string().default(""),
});
export type EmbeddedSignupDTO = z.infer<typeof EmbeddedSignupDTO>;

/** One row of the unified hub activity timeline (inbound + outbound messages
 *  across connected accounts). peer/body are decrypted server-side for display. */
export const ProviderActivityDTO = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  kind: z.string(),
  peer: z.string(),
  body: z.string(),
  status: z.string().nullable().optional(),
  occurredAt: z.string(),
});
export type ProviderActivityDTO = z.infer<typeof ProviderActivityDTO>;

/** Lifecycle of a mention: untouched → turned into a task, or dismissed. */
export const MentionState = z.enum(["pending", "claimed", "ignored"]);
export type MentionState = z.infer<typeof MentionState>;

/** One @-mention of the caller on a connected external account. peer/body are
 *  decrypted server-side for display; the raw provider payload never leaves the
 *  service. `taskId` is set once the mention has been claimed. */
export const MentionDTO = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  kind: z.string(),
  /** Who tagged you — a handle/address, not a Bliss-Work user. */
  peer: z.string(),
  body: z.string(),
  threadRef: z.string().nullable().optional(),
  /** Deep link back to the message on the provider, when it gives us one. */
  permalink: z.string().nullable().optional(),
  state: MentionState,
  taskId: z.string().uuid().nullable().optional(),
  occurredAt: z.string(),
});
export type MentionDTO = z.infer<typeof MentionDTO>;

/** Keyset page of mentions, newest first. `nextCursor` is opaque — pass it back
 *  verbatim; null means this was the last page. */
export const MentionPageDTO = z.object({
  items: z.array(MentionDTO),
  nextCursor: z.string().nullable(),
});
export type MentionPageDTO = z.infer<typeof MentionPageDTO>;

/** A handle the caller owns on an external platform — what mention detection
 *  matches an incoming message against. 'oauth' handles are derived from a
 *  connected account (self-proving); 'declared' ones are typed in by the user. */
export const ProviderIdentityDTO = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  handleKind: z.enum(["account", "email", "phone", "alias"]),
  handle: z.string(),
  source: z.enum(["oauth", "declared"]),
  verified: z.boolean(),
  createdAt: z.string(),
});
export type ProviderIdentityDTO = z.infer<typeof ProviderIdentityDTO>;

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

/**
 * Where an attachment lives, and therefore who may read it.
 *
 * Authorization is by scope rather than "can you see a message referencing
 * this file", because message bodies are encrypted at rest — the server cannot
 * read a message to discover what it points at. Membership is checked when the
 * file is uploaded and RE-CHECKED on every download, so losing access to a
 * channel revokes its files immediately.
 */
export const AttachmentScope = z.enum(["conversation", "thread", "channel"]);
export type AttachmentScope = z.infer<typeof AttachmentScope>;

export const AttachmentDTO = z.object({
  id: z.string().uuid(),
  scope: AttachmentScope,
  scopeId: z.string().uuid(),
  /** "thumb" rows are client-generated posters hanging off a "file" row. */
  role: z.enum(["file", "thumb"]),
  sha256: z.string(),
  /** SERVER-SNIFFED type — never the Content-Type the upload declared. */
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  filename: z.string(),
  /** Client-supplied layout hints; display-only. */
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  createdAt: z.string(),
});
export type AttachmentDTO = z.infer<typeof AttachmentDTO>;

/**
 * A short-lived signed download URL. `<img src>` and `<video src>` cannot send
 * an Authorization header, so the URL itself carries the authorization; it is
 * re-minted before `expiresAt`.
 */
export const AttachmentLinkDTO = z.object({
  id: z.string().uuid(),
  url: z.string(),
  expiresAt: z.string(),
});
export type AttachmentLinkDTO = z.infer<typeof AttachmentLinkDTO>;

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
