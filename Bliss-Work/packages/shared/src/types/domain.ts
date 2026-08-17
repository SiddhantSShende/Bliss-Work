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

/**
 * Membership lifecycle. `suspended` blocks sign-in to this workspace but keeps
 * the membership; `removed` revokes it. Neither deletes the user row — messages,
 * tasks, channel rows and audit entries all reference the id, and the history
 * has to keep rendering their name. Both are reversible by an admin.
 */
export const MemberStatus = z.enum(["active", "suspended", "removed"]);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** A member as the admin screen sees them: directory fields plus the lifecycle
 *  state `UserDTO` deliberately does not carry. */
export const MemberDTO = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string(),
  roles: z.array(Role),
  status: MemberStatus,
  emailVerified: z.boolean().default(true),
  createdAt: z.string(),
  removedAt: z.string().nullable().default(null),
});
export type MemberDTO = z.infer<typeof MemberDTO>;

/** One entry of the tamper-evident audit chain (auth-svc `audit_log`). */
export const AuditEntryDTO = z.object({
  id: z.number().int(),
  actorId: z.string().nullable().default(null),
  action: z.string(),
  target: z.string().nullable().default(null),
  meta: z.record(z.unknown()).nullable().default(null),
  at: z.string(),
});
export type AuditEntryDTO = z.infer<typeof AuditEntryDTO>;

export const AuditPage = z.object({
  entries: z.array(AuditEntryDTO),
  nextCursor: z.number().int().nullable().default(null),
});
export type AuditPage = z.infer<typeof AuditPage>;

// ── Member activity record (telemetry-svc) ───────────────────────────────────
/**
 * Where an activity row came from, and therefore how much it can be trusted.
 *
 * `server` rows are derived from domain events the services emitted while doing
 * the work — unforgeable. Everything else is self-reported by a client. The UI
 * and the export mark the difference, because anyone using this screen to make a
 * decision about a person deserves to know which they are looking at.
 */
export const ActivitySource = z.enum(["server", "web", "desktop", "extension"]);
export type ActivitySource = z.infer<typeof ActivitySource>;

/** Online / idle / offline — three states, where raw presence has only two. */
export const PresenceState = z.enum(["online", "idle", "offline"]);
export type PresenceState = z.infer<typeof PresenceState>;

export const MemberActivityDTO = z.object({
  userId: z.string().uuid(),
  state: PresenceState,
  lastSeenAt: z.string().nullable().default(null),
  lastLoginAt: z.string().nullable().default(null),
  lastLogoutAt: z.string().nullable().default(null),
  todayActiveMs: z.number().default(0),
  last7dActiveMs: z.number().default(0),
  sessionsToday: z.number().default(0),
});
export type MemberActivityDTO = z.infer<typeof MemberActivityDTO>;

export const TimelineEntry = z.object({
  id: z.string(),
  occurredAt: z.string(),
  source: ActivitySource,
  category: z.string(),
  action: z.string(),
  surface: z.string().nullable().default(null),
  targetKind: z.string().nullable().default(null),
  targetId: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  /** Decrypted server-side per row: a message preview, a URL path. Absent when
   *  the row carries no detail, or when the org's key has been shredded. */
  detail: z.record(z.string()).nullable().default(null),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelinePage = z.object({
  entries: z.array(TimelineEntry),
  nextCursor: z.string().nullable().default(null),
});
export type TimelinePage = z.infer<typeof TimelinePage>;

export const ActivitySessionDTO = z.object({
  id: z.string(),
  source: z.string(),
  deviceLabel: z.string(),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  endedAt: z.string().nullable().default(null),
  endReason: z.string().nullable().default(null),
  activeMs: z.number().default(0),
  idleMs: z.number().default(0),
  ipPrefix: z.string().nullable().default(null),
});
export type ActivitySessionDTO = z.infer<typeof ActivitySessionDTO>;

export const ActivitySessionPage = z.object({
  sessions: z.array(ActivitySessionDTO),
  nextCursor: z.string().nullable().default(null),
});
export type ActivitySessionPage = z.infer<typeof ActivitySessionPage>;

export const DayBucket = z.object({
  day: z.string(),
  activeMs: z.number().default(0),
  idleMs: z.number().default(0),
  onlineMs: z.number().default(0),
  sessions: z.number().default(0),
  events: z.number().default(0),
});
export type DayBucket = z.infer<typeof DayBucket>;

export const NamedCount = z.object({
  key: z.string(),
  label: z.string().default(""),
  valueMs: z.number().default(0),
  count: z.number().default(0),
});
export type NamedCount = z.infer<typeof NamedCount>;

export const ActivitySummaryDTO = z.object({
  userId: z.string(),
  from: z.string(),
  to: z.string(),
  totalActiveMs: z.number().default(0),
  totalIdleMs: z.number().default(0),
  totalOnlineMs: z.number().default(0),
  sessions: z.number().default(0),
  events: z.number().default(0),
  days: z.array(DayBucket).default([]),
  bySurface: z.array(NamedCount).default([]),
  byAction: z.array(NamedCount).default([]),
  topApps: z.array(NamedCount).default([]),
  topSites: z.array(NamedCount).default([]),
  /** 7 x 24 grid of active ms, Monday-first, in the server's rollup timezone. */
  hourly: z.array(z.array(z.number())).default([]),
});
export type ActivitySummaryDTO = z.infer<typeof ActivitySummaryDTO>;

export const OrgActivitySummaryDTO = z.object({
  from: z.string(),
  to: z.string(),
  members: z.array(ActivitySummaryDTO).default([]),
  days: z.array(DayBucket).default([]),
});
export type OrgActivitySummaryDTO = z.infer<typeof OrgActivitySummaryDTO>;

/** One flat per-member-per-day row for the .xlsx export. Names are joined from
 *  the directory client-side — telemetry-svc holds no names. */
export const ActivityExportRow = z.object({
  userId: z.string(),
  day: z.string(),
  activeMs: z.number().default(0),
  idleMs: z.number().default(0),
  onlineMs: z.number().default(0),
  sessions: z.number().default(0),
  events: z.number().default(0),
  firstSeenAt: z.string().nullable().default(null),
  lastSeenAt: z.string().nullable().default(null),
  topSurface: z.string().nullable().default(null),
  topApp: z.string().nullable().default(null),
  topSite: z.string().nullable().default(null),
});
export type ActivityExportRow = z.infer<typeof ActivityExportRow>;

/** A paired activity agent — this person's desktop app or browser extension.
 *  The secret itself is never in this shape; it exists once, in the response
 *  that mints it. */
export const AgentTokenDTO = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string().default(""),
  createdAt: z.string().nullable().default(null),
  lastUsedAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
});
export type AgentTokenDTO = z.infer<typeof AgentTokenDTO>;

/** One organization the signed-in identity belongs to — for the org switcher.
 *  A single email/password can span multiple orgs; `active` marks the current one. */
export const OrgMembershipDTO = z.object({
  orgId: z.string().uuid(),
  orgName: z.string(),
  roles: z.array(Role),
  active: z.boolean().default(false),
});
export type OrgMembershipDTO = z.infer<typeof OrgMembershipDTO>;

/**
 * The current organization plus any pending deletion.
 *
 * Three nullable timestamps that mean different things and must not be
 * collapsed: `deleteRequestedAt` = someone asked, `purgeAfter` = the moment it
 * stops being reversible, `deletedAt` = it already happened.
 */
export const OrgLifecycleDTO = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string().nullish(),
  deleteRequestedAt: z.string().nullish(),
  purgeAfter: z.string().nullish(),
  deletedAt: z.string().nullish(),
});
export type OrgLifecycleDTO = z.infer<typeof OrgLifecycleDTO>;

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
/**
 * Which surface started a thread, and therefore whether it belongs in the
 * Inbox. Chats is instant messaging; the Inbox is email-style. Before this
 * distinction existed every DM wrote an Inbox row, which is why chat traffic
 * drove the Inbox badge and People sidebar.
 */
export const ThreadOrigin = z.enum(["chat", "mail"]);
export type ThreadOrigin = z.infer<typeof ThreadOrigin>;

export const MessageKind = z.enum(["text", "call_missed", "forward_external"]);
export type MessageKind = z.infer<typeof MessageKind>;

/**
 * The wire-tolerant variant, and the one every INBOUND payload must use.
 *
 * ApiClient.req throws ApiError(502, "invalid response from server") when a
 * response fails safeParse, and WsClient silently drops frames that fail it. So
 * with a bare enum, the first server-side `kind` a client has never heard of
 * does not degrade that one message — it fails the whole `messages` response
 * and the entire conversation refuses to load. That is a real risk here and not
 * a hypothetical one: the desktop app updates on its own cadence via
 * electron-updater and has historically run weeks behind the web app.
 *
 * `.catch("text")` makes an unknown kind render as an ordinary message instead.
 * Losing the centered-pill styling on an old build is a far better failure than
 * losing the conversation.
 */
export const MessageKindWire = MessageKind.catch("text");

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
  /** System entries (a missed call, a forward handed off to WhatsApp).
   *  Absent = ordinary text. Wire-tolerant: see MessageKindWire. */
  kind: MessageKindWire.optional(),
  /** Set only on the sender's own bubbles. */
  status: MessageStatus.optional(),
  /** Set when the sender has dismissed (sender_dismissed_at IS NOT NULL). */
  dismissedBySender: z.boolean().optional(),
  /** The message this one quotes. Distinct from parentMessageId (threading). */
  replyToId: z.string().uuid().optional(),
  /**
   * "Deleted for everyone". The row still arrives — seq orders the conversation
   * and other tables reference the id — but `body` is empty and the client
   * renders a tombstone in place, so the reader sees that something was removed
   * rather than a gap that quietly rewrites what they remember.
   */
  deletedForAll: z.boolean().optional(),
});

/** One emoji's tally on one message, from the caller's point of view. */
export const ReactionDTO = z.object({
  messageId: z.string().uuid(),
  emoji: z.string(),
  count: z.number().int().positive(),
  /** True when the caller is one of the reactors — renders the chip pressed. */
  mine: z.boolean(),
});
export type ReactionDTO = z.infer<typeof ReactionDTO>;
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
  /** "confirmed" — a provider acknowledged the send. "unconfirmed" — we opened a
   *  wa.me deep link and cannot observe whether the user pressed send. Absent on
   *  payloads from before deep-link forwarding, all of which were confirmed. */
  delivery: z.enum(["confirmed", "unconfirmed"]).catch("confirmed").optional(),
  /** The captured contact's display name, when one was captured. */
  forwardedToName: z.string().nullable().optional(),
  /** Set when the forwarded message lived in a channel rather than a DM. */
  channelId: z.string().uuid().nullable().optional(),
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
  /** At least one hop of this message was a deep link we could not verify. */
  hasUnconfirmed: z.boolean().optional(),
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
   *  set for providers that call us (Slack). Not a secret on its own —
   *  the provider's HMAC signature still authenticates every delivery. */
  webhookUrl: z.string().nullable().optional(),
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
  /**
   * The peer's handle. NOTE: this is derived from the EMAIL LOCAL-PART at
   * signup, so it reads "j.okafor", not "Jane Okafor". Render
   * `peerDisplayName ?? peerUsername` — see lib/userLabel.
   */
  peerUsername: z.string(),
  /** Real name. Absent only while the messaging projection lags a rename. */
  peerDisplayName: z.string().optional(),
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
  /** Real name. Prefer this over `peerUsername`, which is the email local-part. */
  peerDisplayName: z.string().optional(),
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
  /** Real name. Prefer this over `senderUsername`, which is the email local-part. */
  senderDisplayName: z.string().optional(),
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

// ── Availability roster ──────────────────────────────────────────────────────
/** One user's OPEN task counts. Users with no open work at all are absent from
 *  the response entirely, so the client treats a miss as 0/0. */
export const AvailabilityCount = z.object({
  userId: z.string().uuid(),
  /** >0 ⇒ not available. Only ACKNOWLEDGED counts as work in progress. */
  acknowledged: z.number().int().nonnegative(),
  /** SENT (not yet acknowledged) — a hint on the card, never a blocker. */
  pending: z.number().int().nonnegative(),
});
export type AvailabilityCount = z.infer<typeof AvailabilityCount>;

/** Inputs for the Available bucket. task-svc returns only what it owns; the
 *  member list comes from `directory()` and is joined client-side (task-svc's
 *  user_projection is a partial `user.created`-only mirror). */
export const AvailabilityDTO = z.object({
  counts: z.array(AvailabilityCount),
  /** Users an org admin removed from the roster. An organizational filter, not
   *  an access control — these ids are already public via the directory. */
  hiddenUserIds: z.array(z.string().uuid()),
  /** Caller holds org_admin → render the hide / unhide affordances. */
  canManage: z.boolean(),
});
export type AvailabilityDTO = z.infer<typeof AvailabilityDTO>;

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
  /** Who created the channel. Written since the first channels migration and,
   *  until channel roles existed, never read back. */
  createdBy: z.string().default(""),
  /** The CALLER's standing in this channel: "owner" | "admin" | "member", or ""
   *  when they are not a member. Gates the moderation UI; the server re-checks
   *  every action regardless. Defaults to "" so a response from a server that
   *  predates roles still parses. */
  myRole: z.string().default(""),
});
export type ChannelDTO = z.infer<typeof ChannelDTO>;

/** Channel standing. `owner` is the creator (or whoever it was transferred to);
 *  `admin` is a moderator they appointed. An org_admin can moderate any channel
 *  without appearing in its roster at all. */
export const ChannelRole = z.enum(["owner", "admin", "member"]);
export type ChannelRole = z.infer<typeof ChannelRole>;

/** One row of a channel roster. Blocked users appear too — they are not members,
 *  but an admin needs to see who is barred in order to unblock them. */
export const ChannelMemberDTO = z.object({
  userId: z.string().uuid(),
  role: ChannelRole,
  joinedAt: z.string().default(""),
  blocked: z.boolean().default(false),
});
export type ChannelMemberDTO = z.infer<typeof ChannelMemberDTO>;

export const ChannelMessageDTO = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  seq: z.number().int(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  /** Real name. Prefer this over `senderUsername`, which is the email local-part. */
  senderDisplayName: z.string().optional(),
  body: z.string(),
  createdAt: z.string(),
  /** System entries in a channel, mirroring MessageDTO.kind. Absent = text. */
  kind: MessageKindWire.optional(),
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

// ── Calls ────────────────────────────────────────────────────────────────────

/** How a call decides who may be in it. The three differ in exactly one way —
 *  where the roster comes from — and everything else follows from that.
 *
 *  - `CHANNEL`  the roster IS the channel's membership. There is no invite link
 *               and no way to mint one; being in the channel is the invitation,
 *               and leaving it removes the seat.
 *  - `MEETING`  an explicit roster, which is what makes a link meaningful. A
 *               link may be redeemed by any registered BlissWork user, INCLUDING
 *               one in another organisation.
 *  - `DIRECT`   the ad-hoc 1:1 call, which any participant may widen with
 *               another member of their OWN org. */
export const CallKind = z.enum(["DIRECT", "CHANNEL", "MEETING"]);
export type CallKind = z.infer<typeof CallKind>;

export const CallStatus = z.enum(["SCHEDULED", "LIVE", "ENDED", "CANCELLED"]);
export type CallStatus = z.infer<typeof CallStatus>;

export const CallParticipantDTO = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
  role: z.enum(["HOST", "PARTICIPANT"]),
  username: z.string().default(""),
  joinedAt: z.string().nullish(),
  leftAt: z.string().nullish(),
  /** Set while this participant is held in the waiting room, and cleared the
   *  moment the call starts. Non-null is a THIRD state, distinct from both "in
   *  the room" (joinedAt set) and "has not turned up" (neither set): they are
   *  here, and the call has not been opened yet. */
  waitingSince: z.string().nullish(),
  /** True when this participant belongs to a different org than the call —
   *  i.e. they joined a meeting by link. Surfaced in the UI so nobody is
   *  surprised by who is in the room. */
  external: z.boolean().default(false),
});
export type CallParticipantDTO = z.infer<typeof CallParticipantDTO>;

/** What a screen share is showing.
 *
 *  These are the server's names. A browser reports the same three things as
 *  `displaySurface` = "monitor" | "window" | "browser", and the API accepts
 *  either spelling, so a client can forward what getDisplayMedia gave it
 *  without translating. */
export const CallShareSource = z.enum(["SCREEN", "WINDOW", "TAB"]);
export type CallShareSource = z.infer<typeof CallShareSource>;

/** One live screen share.
 *
 *  The share is COORDINATION, not media — the picture itself travels to the SFU
 *  on the same connection as everyone's camera. This is how the room agrees on
 *  who is sharing and what they picked, so a participant who joins mid-share is
 *  told about it rather than inferring it from whichever tracks turn up. */
export const CallShareDTO = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  /** The sharer, and — because there is no endpoint that stops anyone else's
   *  share — the only person whose UI should offer to stop this one. */
  userId: z.string().uuid(),
  source: CallShareSource,
  startedAt: z.string(),
});
export type CallShareDTO = z.infer<typeof CallShareDTO>;

export const CallDTO = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: CallKind,
  channelId: z.string().uuid().nullish(),
  title: z.string().default(""),
  media: z.enum(["audio", "video"]).default("video"),
  createdBy: z.string().uuid(),
  /** Absent for "meet now". */
  scheduledAt: z.string().nullish(),
  startedAt: z.string().nullish(),
  /** Who opened it, which is not always who scheduled it — an org admin or a
   *  channel owner can start a call the organiser is late for. */
  startedBy: z.string().uuid().nullish(),
  endedAt: z.string().nullish(),
  status: CallStatus,
  createdAt: z.string(),
  participants: z.array(CallParticipantDTO).default([]),
  /** What is on screen right now. Present on every read, so opening a call
   *  already tells you a share is in progress. */
  activeShares: z.array(CallShareDTO).default([]),
});
export type CallDTO = z.infer<typeof CallDTO>;

/** Returned ONCE, when the link is minted. The server stores only a SHA-256 of
 *  the token, so this value cannot be recovered afterwards — if it is lost, mint
 *  another and revoke this one. */
export const CallInviteDTO = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  token: z.string(),
  expiresAt: z.string(),
  maxUses: z.number().int().nullish(),
});
export type CallInviteDTO = z.infer<typeof CallInviteDTO>;

/** Everything needed to open the SFU room. Short-lived by design: access is
 *  re-decided from the database on every refresh, so losing channel membership
 *  actually ends the call rather than waiting for a long-lived token to lapse. */
export const CallTokenDTO = z.object({
  state: z.literal("JOINED"),
  url: z.string(),
  token: z.string(),
  room: z.string(),
  identity: z.string(),
  expiresAt: z.string(),
  role: z.enum(["HOST", "PARTICIPANT"]),
});
export type CallTokenDTO = z.infer<typeof CallTokenDTO>;

/** The waiting room: you belong in this call, and it has not started.
 *
 *  Note what is NOT in here — a token. That absence is the whole enforcement:
 *  a client that skips the lobby screen and tries to open the room anyway has
 *  nothing to open it with. The lobby is a fact about what the server issued,
 *  not a screen the client is trusted to render.
 *
 *  Nobody is being reviewed while they wait. There is no admit or deny; the
 *  call starting lets in everyone at once. */
export const CallWaitingDTO = z.object({
  state: z.literal("WAITING"),
  callId: z.string().uuid(),
  status: CallStatus,
  /** Whether THIS caller is one of the people who could end the wait — the
   *  organiser, an org admin, or an owner/admin of the channel. It is answered
   *  server-side because a client cannot see the org and channel roles it would
   *  need to work it out, and it is what turns the same lobby screen into a
   *  "Start meeting" button for one person and "waiting for the host" for
   *  everyone else. */
  canStart: z.boolean(),
});
export type CallWaitingDTO = z.infer<typeof CallWaitingDTO>;

/** What POST /calls/{id}/token answers: a room token (200), or the waiting room
 *  (202). Discriminate on `state` — the status code says the same thing, but the
 *  field survives being passed around after the response is gone. */
export const CallJoinDTO = z.discriminatedUnion("state", [CallTokenDTO, CallWaitingDTO]);
export type CallJoinDTO = z.infer<typeof CallJoinDTO>;
