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
  /** A `data:image/(jpeg|png|webp);base64,...` URI, or null when the user has
   *  never set one — render initials via `Avatar` in that case. */
  avatarUrl: z.string().nullable().default(null),
  /** MFA (this membership's own state, plus the CURRENT org's admin-mandatory
   *  policy denormalized alongside it) — enough to render MfaRequiredBanner
   *  from the session already in hand, no extra round trip. */
  mfaEnrolled: z.boolean().default(false),
  orgRequireMfaForAdmins: z.boolean().default(false),
  orgMfaGracePeriodEndsAt: z.string().nullable().default(null),
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
  avatarUrl: z.string().nullable().default(null),
});
export type MemberDTO = z.infer<typeof MemberDTO>;

/** One entry of the tamper-evident audit chain (auth-svc `audit_log`).
 *  `id` is the audit_log UUIDv7 (time-ordered) as of
 *  migrations/0018_audit_log_uuid_id.sql — previously a bigserial id
 *  stringified as an int. */
export const AuditEntryDTO = z.object({
  id: z.string(),
  actorId: z.string().nullable().default(null),
  action: z.string(),
  target: z.string().nullable().default(null),
  meta: z.record(z.unknown()).nullable().default(null),
  at: z.string(),
});
export type AuditEntryDTO = z.infer<typeof AuditEntryDTO>;

export const AuditPage = z.object({
  entries: z.array(AuditEntryDTO),
  /** The id to pass back as `before` for the next page — a UUIDv7, same as
   *  AuditEntryDTO.id. */
  nextCursor: z.string().nullable().default(null),
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

/**
 * One `user_sessions` row — a signed-in CLIENT INSTANCE (login presence,
 * active/idle time, device label). Despite the name, this is NOT the
 * desktop+browser correlated "Chrome, showing YouTube" record — that is
 * `ActivitySessionEntryDTO` below, a deliberately different name for a
 * deliberately different table (`activity_sessions`, built by telemetry-svc's
 * sessionizer.py). The naming is unfortunate and predates the second table;
 * kept as-is here rather than renamed, since renaming would break every
 * existing caller (MemberSessions.tsx, ExportActivityDialog.tsx,
 * xlsxTelemetry.ts) for a cosmetic fix — flagged here so nobody reaches for
 * this type expecting a merged app+site record and gets confused fields.
 */
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

/**
 * One `activity_sessions` row — the CORRELATED desktop+browser record
 * telemetry-svc's sessionizer.py builds: a desktop `app.focus` span merged
 * with the browser `site.visit` span that overlapped it, or either span
 * standing alone when only one sensor reported. This is the unified
 * activity/session model member-facing UI should read FROM, rather than
 * re-deriving the same merge client-side from raw `TimelineEntry` rows (see
 * activityLabels.ts's `collapseSwitches`, which predates this endpoint and
 * remains a client-side best-effort fallback, not the source of truth).
 *
 * See `ActivitySessionDTO` above for why this is a differently-named type
 * rather than a fix to that name.
 */
export const ActivitySessionEntryDTO = z.object({
  id: z.string(),
  /** 'app' | 'site' | 'app+site' — which sensor(s) contributed. */
  kind: z.string(),
  appName: z.string().nullable().default(null),
  domain: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().default(0),
  /** Decrypted server-side: url, siteKind, siteRef, from — the same shape
   *  TimelineEntry.detail already carries. */
  detail: z.record(z.string()).nullable().default(null),
  /** The activity_events rows this session was built from — see
   *  activityLabels.ts's sessionEntryFor for why matching on these rather
   *  than on startedAt is what makes the lookup immune to clock skew. */
  anchorEventId: z.string().nullable().default(null),
  correlatedEventId: z.string().nullable().default(null),
});
export type ActivitySessionEntryDTO = z.infer<typeof ActivitySessionEntryDTO>;

export const ActivitySessionEntryPage = z.object({
  sessions: z.array(ActivitySessionEntryDTO),
  nextCursor: z.string().nullable().default(null),
});
export type ActivitySessionEntryPage = z.infer<typeof ActivitySessionEntryPage>;

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
  // Distinct from lastUsedAt on purpose: lastSeenAt also moves on a plain
  // status ping, so it can be true ("the credential still works") before the
  // agent has ever sent real activity — see agent.py's report_status.
  lastSeenAt: z.string().nullable().default(null),
  agentVersion: z.string().nullable().default(null),
  platform: z.string().nullable().default(null),
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

/** GET /auth/captcha's response. `captchaImage` is a `data:image/png;base64,...`
 *  URI — the rendered challenge only; the plaintext value it encodes is never
 *  sent to the client in any form. */
export const CaptchaChallengeDTO = z.object({
  captchaId: z.string(),
  captchaImage: z.string(),
  expiresIn: z.number().int(),
});
export type CaptchaChallengeDTO = z.infer<typeof CaptchaChallengeDTO>;

export const SessionDTO = z.object({
  accessToken: z.string(),
  user: UserDTO,
  expiresIn: z.number().int(),
});
export type SessionDTO = z.infer<typeof SessionDTO>;

/**
 * Returned by /auth/login (and /auth/orgs/{id}/switch) IN PLACE OF a session
 * when a second factor is still owed. `pendingToken` is a short-lived,
 * single-use, server-only secret the client presents to the MFA
 * challenge-verify endpoint next — or, while `enrollmentRequired` is true, to
 * the TOTP/WebAuthn enroll-start/enroll-confirm endpoints instead (the
 * "restricted enrollment credential": the only way a blocked admin who has
 * never enrolled can reach enrollment, since there is no session yet to
 * authenticate with).
 */
export const MfaPendingDTO = z.object({
  mfaRequired: z.literal(true).default(true),
  pendingToken: z.string(),
  methods: z.array(z.enum(["totp", "webauthn"])),
  enrollmentRequired: z.boolean().default(false),
});
export type MfaPendingDTO = z.infer<typeof MfaPendingDTO>;

/** What /auth/login and /auth/orgs/{id}/switch actually return — discriminate
 *  on `mfaRequired` (absent/false on a SessionDTO, always true on a pending
 *  challenge). */
export const LoginResult = z.union([SessionDTO, MfaPendingDTO]);
export type LoginResult = z.infer<typeof LoginResult>;

export function isMfaPending(result: LoginResult): result is MfaPendingDTO {
  return "mfaRequired" in result && result.mfaRequired === true;
}

/** GET /auth/mfa/methods — which second factors the CALLER has registered.
 *  Lets Settings decide whether to offer a passkey as a step-up shortcut
 *  (MFA-disable / backup-codes regenerate) without guessing from
 *  `user.mfaEnrolled` alone — a passkey-only enrollee has no TOTP code or
 *  backup code to fall back on for either action. */
export const MfaMethodsResult = z.object({
  methods: z.array(z.enum(["totp", "webauthn"])),
});
export type MfaMethodsResult = z.infer<typeof MfaMethodsResult>;

export const OrgMfaSettingsDTO = z.object({
  requireMfaForAdmins: z.boolean(),
  mfaGracePeriodEndsAt: z.string().nullable().default(null),
});
export type OrgMfaSettingsDTO = z.infer<typeof OrgMfaSettingsDTO>;

export const MfaTotpEnrollStartResult = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type MfaTotpEnrollStartResult = z.infer<typeof MfaTotpEnrollStartResult>;

export const MfaTotpEnrollConfirmResult = z.object({
  backupCodes: z.array(z.string()),
  /** Set only when enrollment was reached via the restricted enrollment
   *  credential — the caller had no session yet, so this one IS it. */
  session: SessionDTO.nullable().default(null),
});
export type MfaTotpEnrollConfirmResult = z.infer<typeof MfaTotpEnrollConfirmResult>;

export const MfaBackupCodesResult = z.object({
  backupCodes: z.array(z.string()),
});
export type MfaBackupCodesResult = z.infer<typeof MfaBackupCodesResult>;

export const MfaWebauthnRegisterFinishResult = z.object({
  id: z.string(),
  nickname: z.string().nullable().default(null),
  session: SessionDTO.nullable().default(null),
});
export type MfaWebauthnRegisterFinishResult = z.infer<typeof MfaWebauthnRegisterFinishResult>;

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

export const MessageKind = z.enum([
  "text",
  "call_missed",
  "forward_external",
  "screenshot_attempt",
]);
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
  /**
   * This message is a copy delivered by forwarding someone else's.
   *
   * Rendered as a "Forwarded" label above the bubble. Without it a forwarded
   * photo looks like one the forwarder took: the same content under their name
   * with nothing to say otherwise.
   */
  isForward: z.boolean().optional(),
});

/** One emoji's tally on one message, from the caller's point of view. */
export const ReactionDTO = z.object({
  messageId: z.string().uuid(),
  emoji: z.string(),
  count: z.number().int().positive(),
  /** True when the caller is one of the reactors — renders the chip pressed. */
  mine: z.boolean(),
  /**
   * Who reacted, oldest first, CAPPED server-side — so this can be shorter than
   * `count`, and `count` stays the authority on how many there were.
   *
   * Optional because it is omitted entirely for a tally with no resolvable
   * names, and because a client may still hold a cached tally from before the
   * field existed.
   */
  reactors: z.array(z.string()).optional(),
});
export type ReactionDTO = z.infer<typeof ReactionDTO>;
export type MessageDTO = z.infer<typeof MessageDTO>;

/**
 * What a bulk "delete for everyone" actually did, shared by the conversation
 * and channel endpoints. `skipped` carries no per-id reason on purpose — the
 * server refuses to say WHY an id it would not delete was skipped (not yours,
 * not found, another scope), the same restraint it applies everywhere else an
 * id could otherwise become an existence oracle. `deleted.length +
 * skipped.length` always equals what was requested.
 */
export const BulkDeleteResultDTO = z.object({
  deleted: z.array(z.string().uuid()),
  skipped: z.array(z.string().uuid()),
});
export type BulkDeleteResultDTO = z.infer<typeof BulkDeleteResultDTO>;

export const ForwardTargetKind = z.enum(["user", "channel"]);
export type ForwardTargetKind = z.infer<typeof ForwardTargetKind>;

/**
 * One destination's outcome from a batch forward (N messages → M
 * destinations). Destination-granular rather than per (message ×
 * destination): the server gives a destination one transaction for the whole
 * ordered batch, so it either takes all of it or none of it.
 */
export const ForwardDestinationResultDTO = z.object({
  targetKind: ForwardTargetKind,
  targetId: z.string().uuid(),
  ok: z.boolean(),
  /** Coarse code ("forbidden" | "internal") when !ok — never the raw server
   *  error text. */
  error: z.string().optional(),
  /** Set for a "user" target — the conversation the copies landed in. */
  conversationId: z.string().uuid().optional(),
  /** Set for a "channel" target. */
  channelId: z.string().uuid().optional(),
  /** The delivered clones, in the order the sources were sent — empty when
   *  !ok. */
  messageIds: z.array(z.string().uuid()).default([]),
});
export type ForwardDestinationResultDTO = z.infer<typeof ForwardDestinationResultDTO>;

export const BulkForwardResultDTO = z.object({
  results: z.array(ForwardDestinationResultDTO),
});
export type BulkForwardResultDTO = z.infer<typeof BulkForwardResultDTO>;

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
  lastMessageSender: z.string().default(""),
  /** Who sent lastMessage — used to tell "I sent it" from "I received it"
   *  (e.g. the Link sent/Link received preview label) without relying on a
   *  display name, which is user-editable and can collide between members.
   *  Empty when there is no last message. */
  lastMessageSenderId: z.string().default(""),
  /** True once the caller has cleared/hidden every message in this
   *  conversation but it genuinely has history. The list shows a blank
   *  preview rather than `lastMessage` (null here) or a placeholder. */
  cleared: z.boolean().default(false),
  unread: z.number().int(),
  /** The caller blocked the peer ("You blocked this user"). */
  blockedByMe: z.boolean().default(false),
  /** The peer blocked the caller ("You have been blocked"). */
  blockedByPeer: z.boolean().default(false),
});
export type ConversationDTO = z.infer<typeof ConversationDTO>;

// ── Inbox (unified message threads + tasks + mail) ───────────────────────────
export const InboxItemKind = z.enum(["THREAD", "TASK", "MAIL"]);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

/**
 * Single row in the unified inbox feed. A THREAD row points to a message
 * thread; a MAIL row points to an email; a TASK row points to a task assigned
 * to this user. Status/preview differ per kind.
 *
 * TASK rows are still produced by the task projector and still returned here —
 * the Inbox surface filters them out because it presents itself as a mailbox,
 * but the kind stays in the contract because the row is real, deep links to it
 * still resolve, and the People sidebar's rollups still count it.
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

// ── Mail ─────────────────────────────────────────────────────────────────────
export const MailRecipientKind = z.enum(["TO", "CC", "BCC"]);
export type MailRecipientKind = z.infer<typeof MailRecipientKind>;

/**
 * One addressee on a mail header.
 *
 * BCC entries are filtered SERVER-side per viewer: the author sees the list
 * they typed, everyone else sees To and Cc plus their own BCC entry. So a BCC
 * appearing here is never someone else's — it is either yours or your own mail.
 */
export const MailRecipientDTO = z.object({
  kind: MailRecipientKind,
  address: z.string(),
  /** Set when the address resolved to a member of this org at send time. */
  userId: z.string().uuid().nullable(),
  displayName: z.string().nullable(),
});
export type MailRecipientDTO = z.infer<typeof MailRecipientDTO>;

/** One file on a mail. Downloads go through the same signed-link mint as chat
 *  attachments (`attachmentLinks`), which re-checks access on every hit. */
export const MailAttachmentDTO = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type MailAttachmentDTO = z.infer<typeof MailAttachmentDTO>;

/** A complete email — the payload behind an opened Inbox row. */
export const MailDTO = z.object({
  mailId: z.string().uuid(),
  status: z.enum(["DRAFT", "SENT", "RECEIVED"]),
  /** The CALLER's view: SENT if they wrote it, INBOX if it reached them. One
   *  row is both, seen from two sides. */
  folder: z.enum(["INBOX", "SENT"]),
  fromAddress: z.string(),
  fromName: z.string(),
  /** Null for mail from outside the org — there is no local account behind it. */
  fromUserId: z.string().uuid().nullable(),
  subject: z.string(),
  bodyText: z.string(),
  /** Only ever set for inbound multipart/alternative mail. UNTRUSTED markup —
   *  never inject it; the text body is what the renderer shows. */
  bodyHtml: z.string().nullable(),
  recipients: z.array(MailRecipientDTO),
  attachments: z.array(MailAttachmentDTO),
  sentAt: z.string(),
  readAt: z.string().nullable(),
});
export type MailDTO = z.infer<typeof MailDTO>;

/**
 * One row of the Drafts folder — a mail the author has written but not sent.
 *
 * Deliberately not an `InboxItemDTO`: a draft is in nobody's feed, so it has no
 * counterparty, no unread state and no delivery. What it does have is the
 * people it is addressed to so far and the moment it was last touched.
 */
export const MailDraftDTO = z.object({
  mailId: z.string().uuid(),
  /** `subject — body`, the same one-line preview the feed builds for sent mail,
   *  so a draft row reads like every other row in the mailbox. */
  preview: z.string(),
  /** The To line as typed. Empty is ordinary — mail is often written before it
   *  is addressed. */
  to: z.array(z.string()),
  attachmentCount: z.number().int().nonnegative(),
  /** When the author last edited it. Drafts are listed newest-edit first. */
  updatedAt: z.string(),
});
export type MailDraftDTO = z.infer<typeof MailDraftDTO>;

/** What POST /mail/drafts/{id}/send answers with. The two counts let the UI say
 *  what actually happened when a mail is addressed both inside and outside the
 *  org — "sent to 2, queued for 1" rather than a bare "sent". */
export const SendMailResultDTO = z.object({
  mailId: z.string().uuid(),
  sentAt: z.string(),
  deliveredInApp: z.number().int().nonnegative(),
  queuedExternal: z.number().int().nonnegative(),
});
export type SendMailResultDTO = z.infer<typeof SendMailResultDTO>;

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
  /** CHANNEL_ADDED is the one non-task kind: notification-svc writes it when
   *  someone adds you to a channel. Kept an enum rather than a bare string so a
   *  server that starts emitting a kind this client cannot render fails loudly
   *  in one place instead of rendering a blank row. */
  kind: z.enum([
    "TASK_ACKNOWLEDGED",
    "TASK_COMPLETED",
    "TASK_IGNORED",
    "TASK_LEFT",
    "CHANNEL_ADDED",
  ]),
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
  /** Display name (falling back to username) of whoever sent lastMessage —
   *  server-resolved, unlike ConversationDTO's same-named field (a DM only
   *  ever has two possible senders, both already named elsewhere on that
   *  DTO, so it never populates this). Drives the "<Name>: preview" list
   *  label. Empty when there is no last message or the sender's projection
   *  hasn't caught up yet. */
  lastMessageSender: z.string().default(""),
  /** Who sent lastMessage — used to tell "I sent it" from "I received it"
   *  (e.g. the Link sent/Link received preview label) without relying on a
   *  display name, which is user-editable and can collide between members.
   *  Empty when there is no last message. */
  lastMessageSenderId: z.string().default(""),
  /** True once the caller has cleared/hidden every message in this channel
   *  but it genuinely has history. The list shows a blank preview rather
   *  than `lastMessage` (null here) or the member-count placeholder. */
  cleared: z.boolean().default(false),
  /** The caller's unread count for this channel — messages after their
   *  read cursor. Mirrors ConversationDTO.unread; 0 for /channels/open
   *  (unread has no meaning for a channel you have not joined). */
  unread: z.number().int().default(0),
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
  /** Mirrors MessageDTO.isForward. */
  isForward: z.boolean().optional(),
  /** Tombstone: deleted for everyone. `body` is EMPTY on the wire when this is
   *  set — the server never decrypts a deleted message, so there is nothing
   *  here for a client to be trusted to conceal. */
  deletedForAll: z.boolean().optional(),
  /** Pinned for the whole channel by a moderator. */
  pinned: z.boolean().optional(),
  /** The message this one quotes. Mirrors MessageDTO.replyToId. */
  replyToId: z.string().uuid().optional(),
});
export type ChannelMessageDTO = z.infer<typeof ChannelMessageDTO>;

export const ChannelReadReceiptDTO = z.object({
  messageId: z.string().uuid(),
  readerId: z.string().uuid(),
  readerName: z.string(),
  readAt: z.string(),
});
export type ChannelReadReceiptDTO = z.infer<typeof ChannelReadReceiptDTO>;

/**
 * Where an attachment lives, and therefore who may read it.
 *
 * Authorization is by scope rather than "can you see a message referencing
 * this file", because message bodies are encrypted at rest — the server cannot
 * read a message to discover what it points at. Membership is checked when the
 * file is uploaded and RE-CHECKED on every download, so losing access to a
 * channel revokes its files immediately.
 */
export const AttachmentScope = z.enum(["conversation", "thread", "channel", "mail"]);
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

/** How far along a call's recording is.
 *
 *  RECORDING is the live state — the SFU is writing the file and there is
 *  nothing to play yet. READY means the file has landed and been measured.
 *  FAILED is kept rather than deleted so a host who was told "this is being
 *  recorded" is not left wondering where it went. */
export const CallRecordingStatus = z.enum(["RECORDING", "READY", "FAILED"]);
export type CallRecordingStatus = z.infer<typeof CallRecordingStatus>;

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
  /** When the call is scheduled to be OVER, which is a plan rather than
   *  history — `endedAt` is history. The server ends a call that reaches this
   *  without anybody pressing End, so an organiser who closes their laptop no
   *  longer leaves a meeting running and its participants showing as busy.
   *
   *  Absent on a call that named no duration; those end when the last person
   *  leaves the room. */
  endsAt: z.string().nullish(),
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
  /** "RECORDING" while the SFU is writing a recording of this call, "READY"
   *  once there is something to play, absent when neither is true.
   *
   *  It carries two jobs on purpose. It is what tells a PARTICIPANT they are
   *  being recorded — which is not something anyone should discover
   *  afterwards — and it is what lets a list of past meetings offer playback
   *  without minting a signed link per row. The link itself comes from GET
   *  /calls/{id}/recording, one at a time, and expires.
   *
   *  A failed recording is reported as neither: there is nothing to play, and
   *  the failure is the operator's to see, not the participants'. */
  recordingStatus: CallRecordingStatus.exclude(["FAILED"]).nullish(),
});
export type CallDTO = z.infer<typeof CallDTO>;

/** One message from a meeting's chat, as it was KEPT.
 *
 *  Only messages addressed to the whole room are stored. A directed message is
 *  delivered by the SFU to one participant and to nobody else, and persisting
 *  it would widen an audience the sender deliberately narrowed — so the server
 *  has nowhere to put one and the client never offers it one. The live chat in
 *  the room still carries both; this is the durable record, and the record is
 *  of what the room said.
 *
 *  No sender NAME: it is looked up from the directory at render time like every
 *  other author in this product, so an old transcript does not keep calling
 *  somebody by a name they have since changed. */
export const CallChatMessageDTO = z.object({
  id: z.string(),
  callId: z.string().uuid(),
  senderId: z.string().uuid(),
  text: z.string(),
  sentAt: z.string(),
});
export type CallChatMessageDTO = z.infer<typeof CallChatMessageDTO>;

/** One point somebody wrote down during a meeting. */
export const CallNoteDTO = z.object({
  id: z.string(),
  callId: z.string().uuid(),
  authorId: z.string().uuid(),
  text: z.string(),
  writtenAt: z.string(),
});
export type CallNoteDTO = z.infer<typeof CallNoteDTO>;

/** A page of a transcript, oldest first, plus the cursor that continues it.
 *  `nextCursor` is null on the last page — which is what "load more" keys off,
 *  rather than guessing from a short page. */
export const CallChatPageDTO = z.object({
  items: z.array(CallChatMessageDTO).default([]),
  nextCursor: z.string().nullish(),
});
export type CallChatPageDTO = z.infer<typeof CallChatPageDTO>;

export const CallNotePageDTO = z.object({
  items: z.array(CallNoteDTO).default([]),
  nextCursor: z.string().nullish(),
});
export type CallNotePageDTO = z.infer<typeof CallNotePageDTO>;

/** A page of finished meetings, newest first. Separate from `myCalls()`, which
 *  answers "what am I expected at" in one bounded shot — this one has no end,
 *  so it has a cursor. */
export const CallPageDTO = z.object({
  items: z.array(CallDTO).default([]),
  nextCursor: z.string().nullish(),
});
export type CallPageDTO = z.infer<typeof CallPageDTO>;

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


/** A call's recording, with a signed link when there is something to play.
 *
 *  `url` is a path on the messaging service, not an absolute URL — the same
 *  shape AttachmentLinkDTO uses, and for the same reason: the caller knows its
 *  own API base and the token inside is what carries the authorization. */
export const CallRecordingDTO = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  status: CallRecordingStatus,
  mime: z.string().default("video/mp4"),
  sizeBytes: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  endedAt: z.string().nullish(),
  /** Signed playback path, present only once the recording is READY. */
  url: z.string().default(""),
  expiresAt: z.string().nullish(),
});
export type CallRecordingDTO = z.infer<typeof CallRecordingDTO>;

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
