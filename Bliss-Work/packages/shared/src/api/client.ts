/**
 * Thin typed REST client. One instance per app; talks to all services through
 * the per-service base URLs (no API gateway in MVP). Access token is supplied
 * by a getter so it can live in memory (web) or the Electron secure store.
 */
import { z } from "zod";
import {
  AttachmentDTO,
  AttachmentLinkDTO,
  type AttachmentScope,
  ActivityExportRow,
  ActivitySessionPage,
  ActivitySessionEntryPage,
  AgentTokenDTO,
  ActivitySummaryDTO,
  AuditPage,
  AvailabilityDTO,
  BulkDeleteResultDTO,
  BulkForwardResultDTO,
  CaptchaChallengeDTO,
  CallDTO,
  CallChatMessageDTO,
  CallChatPageDTO,
  CallNoteDTO,
  CallNotePageDTO,
  CallPageDTO,
  CallInviteDTO,
  CallJoinDTO,
  CallRecordingDTO,
  CallRecordingStatus,
  CallShareDTO,
  type CallShareSource,
  ChannelDTO,
  ChannelMemberDTO,
  type ChannelRole,
  ChannelMessageDTO,
  ChannelReadReceiptDTO,
  ConversationDTO,
  ReactionDTO,
  type Role,
  InboxItemKind,
  InboxPageDTO,
  InboxPeerDTO,
  MailDTO,
  MailDraftDTO,
  SendMailResultDTO,
  InviteDTO,
  LoginResult,
  MemberActivityDTO,
  MemberDTO,
  MessageDTO,
  type MessageKind,
  MfaBackupCodesResult,
  MfaTotpEnrollConfirmResult,
  MfaTotpEnrollStartResult,
  MfaWebauthnRegisterFinishResult,
  type ThreadOrigin,
  NotificationDTO,
  OrgMembershipDTO,
  OrgLifecycleDTO,
  OrgMfaSettingsDTO,
  ReviewResponse,
  SentTaskDTO,
  StickyTaskDTO,
  TaskExportRow,
  OrgActivitySummaryDTO,
  ThreadDTO,
  TimelinePage,
  UserDTO,
  SessionDTO,
} from "../types/domain";
import {
  ApiErrorBody,
  ErrorCode,
  httpStatusToCode,
} from "../types/errors";
import type { GraphqlOperationName } from "../graphql/operations";

export interface ApiConfig {
  authBase: string; // e.g. http://localhost:8001
  taskBase: string; // e.g. http://localhost:8002
  messagingBase: string; // e.g. http://localhost:8004
  telemetryBase: string; // member activity record, e.g. http://localhost:8006
  notificationBase: string; // notifications are served by task/notification svc
  presenceBase: string; // ws-gateway HTTP, e.g. http://localhost:8090
  /**
   * Read-composition GraphQL gateway, e.g. http://localhost:8007.
   *
   * OPTIONAL, and deliberately so. The gateway fronts a handful of read paths;
   * everything else — writes, uploads, exports, realtime, auth — talks to the
   * REST services directly and always will. A build with this unset simply
   * takes the REST path on those screens too, which is what makes the rollout
   * reversible by configuration rather than by deploy.
   */
  graphBase?: string;
  getToken: () => string | null | Promise<string | null>;
  /**
   * Mint a fresh access token when an authed request 401s (the short-lived
   * access token expired). Returns the new token, or null if refresh failed.
   * Called at most once per request, then the request is retried. MUST be
   * single-flight (the refresh token rotates; concurrent refreshes revoke the
   * session) — callers wire this to the shared `refreshSession`.
   */
  refreshToken?: () => Promise<string | null>;
  /** Abort an in-flight request after this many ms (default 30000) so a stalled
   *  connection can't pin a request — and the UI state waiting on it — open
   *  forever. Each attempt (including the post-refresh retry) gets a fresh timer. */
  timeoutMs?: number;
}

/** Shared `?from=&to=` builder. Dates are ABSOLUTE and computed by the client in
 *  the viewer's timezone — the server never interprets "last week", because only
 *  the client knows where the user is. Same rule as the tasks export. */
function rangeQuery(range: { from?: string; to?: string }): string {
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

function uuid(): string {
  // RFC4122 v4 for client_msg_id / idempotency keys (crypto.randomUUID is fine here).
  return (globalThis.crypto as Crypto).randomUUID();
}

/**
 * Default page size for conversation and channel history.
 *
 * Chat history used to arrive in one unbounded response: opening a conversation
 * fetched every message it had ever held, decrypted row by row on the server and
 * rendered in full by the client. 50 is the server's default and 100 its hard
 * cap (see messaging-svc internal/api/pagination.go) — asking for more than the
 * cap does not fail, it silently returns the default.
 */
export const MESSAGE_PAGE_SIZE = 50;

/** The GraphQL over-HTTP response envelope. `data` is validated by the CALLER's
 *  schema, not here — this only pins the envelope's own shape. */
const GraphqlEnvelope = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
      }),
    )
    .optional(),
});

/** The gateway echoes the platform's own ErrorCode vocabulary in
 *  `extensions.code`. Anything else is treated as absent rather than trusted —
 *  the UI switches on these values. */
function asErrorCode(code: string | undefined): ErrorCode | undefined {
  const known: ErrorCode[] = [
    "bad_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "validation_error",
    "rate_limited",
    "internal_error",
    "service_unavailable",
    "gateway_timeout",
  ];
  return known.find((c) => c === code);
}

/**
 * How many message ids one channel-receipts request may carry.
 *
 * Mirrors MaxMessagePageSize in messaging-svc, which caps the same list on the
 * other side. Both ends bound it: the server because a caller decides the size
 * of that `ANY($2)`, and the client because these ids are a query string and
 * the thread it draws them from grows without limit as older pages load.
 */
const CHANNEL_RECEIPT_IDS_MAX = 100;

export class ApiClient {
  constructor(private readonly cfg: ApiConfig) {}

  private async req<T>(
    base: string,
    path: string,
    init: RequestInit = {},
    // Bind T to the schema's OUTPUT type. Pinning the Input param to `unknown`
    // (rather than the bare `z.ZodType<T>`) is what makes inference pick the
    // output side for schemas carrying `.default()` (e.g. ChannelDTO's
    // isLocked/iAmMember) — otherwise T would resolve to the looser input type
    // where those fields are optional, leaking `boolean | undefined` downstream.
    schema?: z.ZodType<T, z.ZodTypeDef, unknown>,
    retried = false,
  ): Promise<T> {
    const token = await this.cfg.getToken();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    };
    if (token) headers["authorization"] = `Bearer ${token}`;

    // Abort a hung request after timeoutMs (default 30s). Without this a stalled
    // TCP connection blocks the promise — and any UI waiting on it — indefinitely.
    const controller = new AbortController();
    const timeoutMs = this.cfg.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers,
        credentials: "include",
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ApiError(408, `request timed out after ${timeoutMs}ms`);
      }
      throw e; // network / DNS failure — surface as-is
    } finally {
      clearTimeout(timer);
    }
    // Access tokens expire after ~15 min. When an AUTHED request 401s, silently
    // refresh once and retry so an expired token self-heals instead of
    // cascading 401s across every screen. Guard on `token` so a genuinely
    // unauthenticated 401 (e.g. a bad login) stays a real error, and on
    // `retried` so a still-401 after refresh fails out instead of looping.
    // The retry re-reads getToken(), which now returns the refreshed token.
    // NOTE: this fires once per 401'd request, and the presence poll alone runs
    // every 20s on three screens. When the refresh token itself is dead that
    // adds up to an endless drip of doomed refreshes, so `refreshSession` keeps
    // a circuit breaker (see packages/app/src/lib/refresh.ts) and answers null
    // locally once the session is terminal. Retrying here stays correct.
    if (res.status === 401 && token && !retried && this.cfg.refreshToken) {
      const fresh = await this.cfg.refreshToken();
      if (fresh) return this.req<T>(base, path, init, schema, true);
    }
    if (!res.ok) {
      throw await ApiError.fromResponse(res);
    }
    if (res.status === 204) return undefined as T;
    if (schema) {
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("response validation failed", path, parsed.error.issues);
        throw new ApiError(502, "invalid response from server", { code: undefined });
      }
      return parsed.data;
    }
    return (await res.json()) as T;
  }

  /**
   * Execute one REGISTERED GraphQL operation against the read-composition
   * gateway. See `packages/shared/src/graphql/operations.ts` for the registry.
   *
   * ── Why this is a GET, and why only a name goes over the wire ──────────────
   * The document lives on both sides already, so only its name and variables
   * travel. That keeps the URL stable and cacheable — a POST to /graphql would
   * throw away the HTTP caching the REST endpoints behind Caddy already get,
   * which would make the gateway a downgrade on exactly the screens it is meant
   * to speed up.
   *
   * ── Partial results are a feature, not a failure ───────────────────────────
   * A GraphQL response can carry BOTH data and errors: when one upstream
   * service is down, the nullable fields it backs come back null and the rest of
   * the screen still renders. That is the degradation the gateway was built for,
   * so a partial response resolves rather than throwing, and the caller's schema
   * decides whether the missing field is tolerable. Only a response with NO data
   * is an error.
   */
  async graphql<T>(
    operationName: GraphqlOperationName,
    variables: Record<string, unknown> | undefined,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const base = this.cfg.graphBase;
    if (!base) {
      // A caller reached a GraphQL path in a build that has no gateway. That is
      // a wiring mistake, not a runtime condition — say so plainly rather than
      // failing later with a confusing network error.
      throw new ApiError(501, "graphBase is not configured; this build has no GraphQL gateway");
    }

    const qs = new URLSearchParams({ operationName });
    if (variables) qs.set("variables", JSON.stringify(variables));

    const envelope = await this.req(base, `/graphql?${qs.toString()}`, {}, GraphqlEnvelope);

    if (envelope.data === null || envelope.data === undefined) {
      const first = envelope.errors?.[0];
      throw new ApiError(502, first?.message ?? "the GraphQL gateway returned no data", {
        code: asErrorCode(first?.extensions?.code),
      });
    }
    if (envelope.errors?.length) {
      // Partial: something is degraded but the screen can still draw. Surface it
      // for diagnosis without breaking the render.
      console.warn("graphql partial result", operationName, envelope.errors);
    }

    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) {
      console.warn("graphql response validation failed", operationName, parsed.error.issues);
      throw new ApiError(502, "invalid response from the GraphQL gateway");
    }
    return parsed.data;
  }

  // ── auth / org / invite ─────────────────────────────────────────────────────
  /** A fresh CAPTCHA challenge — required on both createOrg and login. Calling
   *  this again (e.g. the form's "refresh" button, or after a failed attempt)
   *  mints a completely new captchaId/image; the old one is simply abandoned
   *  (it stays independently single-use and short-lived on the server). */
  getCaptcha() {
    return this.req(this.cfg.authBase, "/auth/captcha", {}, CaptchaChallengeDTO);
  }
  createOrg(body: {
    orgName: string;
    email: string;
    password: string;
    displayName: string;
    captchaId: string;
    captchaValue: string;
  }) {
    return this.req(this.cfg.authBase, "/auth/orgs", {
      method: "POST",
      body: JSON.stringify(body),
    }, SessionDTO);
  }
  /** Returns either a session, or an MfaPendingDTO when a second factor is
   *  still owed — check with `isMfaPending()` before treating the result as
   *  a session. */
  login(body: { email: string; password: string; captchaId: string; captchaValue: string }) {
    return this.req(this.cfg.authBase, "/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }, LoginResult);
  }
  verifyInvite(token: string) {
    return this.req(
      this.cfg.authBase,
      `/auth/invites/verify?token=${encodeURIComponent(token)}`,
      {},
      z.object({ email: z.string(), orgName: z.string(), valid: z.boolean() }),
    );
  }
  acceptInvite(body: { token: string; password: string; displayName: string; username: string }) {
    return this.req(this.cfg.authBase, "/auth/invites/accept", {
      method: "POST",
      body: JSON.stringify(body),
    }, SessionDTO);
  }
  createInvite(body: { email: string; role: "org_admin" | "member" }) {
    return this.req(this.cfg.authBase, "/auth/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }, z.object({ id: z.string() }));
  }
  listInvites() {
    return this.req(this.cfg.authBase, "/auth/invites", {}, z.array(InviteDTO));
  }
  revokeInvite(id: string) {
    return this.req<void>(this.cfg.authBase, `/auth/invites/${id}`, { method: "DELETE" });
  }
  /** Everyone in the org. Suspended/removed members are excluded unless
   *  `includeInactive` is set, which the server honours for org_admins only —
   *  needed so a departed colleague's name still resolves in admin screens and
   *  in historical exports. */
  directory(includeInactive = false) {
    const q = includeInactive ? "?includeInactive=true" : "";
    return this.req(this.cfg.authBase, `/auth/directory${q}`, {}, z.array(UserDTO));
  }

  // ── member administration (org_admin) ────────────────────────────────────────
  /** Every membership including suspended and removed ones — this is the screen
   *  they are reactivated from, so hiding them would strand them. */
  listMembers() {
    return this.req(this.cfg.authBase, "/auth/members", {}, z.array(MemberDTO));
  }
  changeMemberRole(userId: string, role: Role) {
    return this.req(this.cfg.authBase, `/auth/members/${userId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }, MemberDTO);
  }
  /** Suspend: membership survives, every session dies, sign-in is refused. */
  deactivateMember(userId: string) {
    return this.req(this.cfg.authBase, `/auth/members/${userId}/deactivate`, {
      method: "POST",
    }, MemberDTO);
  }
  reactivateMember(userId: string) {
    return this.req(this.cfg.authBase, `/auth/members/${userId}/reactivate`, {
      method: "POST",
    }, MemberDTO);
  }
  /** Remove from the workspace. Soft — their messages, tasks and audit trail
   *  keep resolving their name, and they can be re-invited. */
  removeMember(userId: string) {
    return this.req(this.cfg.authBase, `/auth/members/${userId}`, {
      method: "DELETE",
    }, MemberDTO);
  }
  // ── member activity record (telemetry-svc) ──────────────────────────────────
  // `userId` accepts the literal "me" so a member can read their own record
  // without knowing their id. The server resolves the subject through a single
  // function: your own record always, anyone else's only as an org_admin.
  /** Live roster: who is online/idle/offline, last login, today's active time. */
  memberActivity() {
    return this.req(this.cfg.telemetryBase, "/telemetry/members", {}, z.array(MemberActivityDTO));
  }
  activityTimeline(
    userId: string,
    opts: { cursor?: string; limit?: number; category?: string } = {},
  ) {
    const q = new URLSearchParams();
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.category) q.set("category", opts.category);
    const qs = q.toString();
    return this.req(
      this.cfg.telemetryBase,
      `/telemetry/members/${userId}/timeline${qs ? `?${qs}` : ""}`,
      {}, TimelinePage,
    );
  }
  /** `user_sessions` — login presence (device, active/idle time). NOT the
   *  correlated app+site record; see `activitySessionEntries` for that, and
   *  `ActivitySessionDTO`'s own doc comment for why the two are named
   *  differently despite the similar method names. */
  activitySessions(userId: string, opts: { cursor?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.req(
      this.cfg.telemetryBase,
      `/telemetry/members/${userId}/sessions${qs ? `?${qs}` : ""}`,
      {}, ActivitySessionPage,
    );
  }
  /** `activity_sessions` — the CORRELATED desktop+browser record
   *  ("Chrome, showing YouTube, 15:00-15:14" as one row) sessionizer.py
   *  builds. This is the unified activity/session model the member timeline
   *  reads from. See `ActivitySessionEntryDTO`'s doc comment. */
  activitySessionEntries(userId: string, opts: { cursor?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.req(
      this.cfg.telemetryBase,
      `/telemetry/members/${userId}/activity-sessions${qs ? `?${qs}` : ""}`,
      {}, ActivitySessionEntryPage,
    );
  }
  activitySummary(userId: string, range: { from?: string; to?: string } = {}) {
    return this.req(
      this.cfg.telemetryBase,
      `/telemetry/members/${userId}/summary${rangeQuery(range)}`,
      {}, ActivitySummaryDTO,
    );
  }
  orgActivitySummary(range: { from?: string; to?: string } = {}) {
    return this.req(
      this.cfg.telemetryBase, `/telemetry/org/summary${rangeQuery(range)}`,
      {}, OrgActivitySummaryDTO,
    );
  }
  /** Flat rollup rows for the spreadsheet builder — not raw events: a year of
   *  raw activity is millions of rows and no use in Excel. */
  exportActivity(opts: { scope: "member" | "org"; userId?: string; from?: string; to?: string }) {
    const q = new URLSearchParams({ scope: opts.scope });
    if (opts.userId) q.set("userId", opts.userId);
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    return this.req(
      this.cfg.telemetryBase, `/telemetry/export?${q.toString()}`,
      {}, z.array(ActivityExportRow),
    );
  }
  /**
   * Flush a batch of client-observed activity.
   *
   * `keepalive` — not sendBeacon. sendBeacon cannot set an Authorization header,
   * and with a JSON content-type it triggers a preflight it cannot complete
   * during unload, which forces text/plain — exactly the shape the WAF flags.
   * keepalive fetch keeps the normal bearer path and is honoured for bodies
   * under 64KB in every engine, including during pagehide.
   */
  sendBeacon(body: unknown) {
    return this.req(
      this.cfg.telemetryBase, "/telemetry/beacon",
      { method: "POST", body: JSON.stringify(body), keepalive: true },
      z.object({ sessionId: z.string(), accepted: z.number() }),
    );
  }

  /** The org's tamper-evident audit trail, newest first. `before` is the
   *  `nextCursor` of the previous page. */
  // ── activity agents (desktop sampler / browser extension) ───────────────────
  /** Mint a pairing secret for one of YOUR OWN agents. The raw value is
   *  returned exactly once and never again — losing it means minting another,
   *  which is the correct cost for a credential that writes your activity.
   *
   *  `deviceKey` makes this safe to call automatically (e.g. right after
   *  login) instead of only from an explicit "Connect" click: a repeat call
   *  for the same device returns the existing row with `token: null` rather
   *  than minting a second live secret. Omit it for today's manual
   *  "Connect" buttons, which must keep minting a fresh token every time. */
  createAgentToken(kind: "desktop" | "extension", label = "", deviceKey?: string) {
    const q = new URLSearchParams({ kind });
    if (label) q.set("label", label);
    if (deviceKey) q.set("deviceKey", deviceKey);
    return this.req(this.cfg.telemetryBase, `/telemetry/tokens?${q.toString()}`, {
      method: "POST",
    }, z.object({ id: z.string(), kind: z.string(), token: z.string().nullable() }));
  }
  listAgentTokens() {
    return this.req(this.cfg.telemetryBase, "/telemetry/tokens", {}, z.array(AgentTokenDTO));
  }
  revokeAgentToken(id: string) {
    return this.req<void>(this.cfg.telemetryBase, `/telemetry/tokens/${id}`, {
      method: "DELETE",
    });
  }
  // NOTE: reporting a status heartbeat (POST /telemetry/tokens/status) is
  // deliberately NOT a method here. It is called with the agent's OWN
  // X-Ingest-Token, not the signed-in member's session — this class always
  // attaches the session bearer token via cfg.getToken() (see req() above),
  // which is exactly what an agent must never hold. The desktop sampler and
  // the extension background script call it with a plain fetch(), the same
  // way they already call /telemetry/ingest/agent.

  // ── channel moderation ──────────────────────────────────────────────────────
  /** Members WITH roles, plus anyone blocked. A separate route from
   *  `channelMembers()`, whose bare string[] the task dialog depends on. */
  channelRoster(channelId: string) {
    return this.req(
      this.cfg.messagingBase, `/api/v1/channels/${channelId}/members/roster`,
      {}, z.array(ChannelMemberDTO),
    );
  }
  kickChannelMember(channelId: string, userId: string) {
    return this.req<void>(
      this.cfg.messagingBase, `/api/v1/channels/${channelId}/members/${userId}`,
      { method: "DELETE" },
    );
  }
  setChannelMemberRole(channelId: string, userId: string, role: ChannelRole) {
    return this.req<void>(
      this.cfg.messagingBase, `/api/v1/channels/${channelId}/members/${userId}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  }
  /** Bars someone from the channel AND removes them. The block outlives
   *  membership, which is what stops them re-joining an open channel. */
  blockFromChannel(channelId: string, userId: string, reason = "") {
    return this.req<void>(
      this.cfg.messagingBase, `/api/v1/channels/${channelId}/blocks/${userId}`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
  }
  unblockFromChannel(channelId: string, userId: string) {
    return this.req<void>(
      this.cfg.messagingBase, `/api/v1/channels/${channelId}/blocks/${userId}`,
      { method: "DELETE" },
    );
  }

  auditLog(opts: { before?: number; limit?: number; action?: string; targetId?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", String(opts.before));
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.action) q.set("action", opts.action);
    if (opts.targetId) q.set("targetId", opts.targetId);
    const qs = q.toString();
    return this.req(this.cfg.authBase, `/auth/audit${qs ? `?${qs}` : ""}`, {}, AuditPage);
  }
  me() {
    return this.req(this.cfg.authBase, "/auth/me", {}, UserDTO);
  }
  /** Both fields are independently optional — the Profile page saves a
   *  display-name edit and an avatar upload as two separate actions that
   *  happen to share this endpoint. `avatarUrl` is a client-resized
   *  `data:image/(jpeg|png|webp);base64,...` URI (see lib/thumbnail.ts). */
  updateProfile(body: { displayName?: string; avatarUrl?: string }) {
    return this.req(this.cfg.authBase, "/auth/me", {
      method: "PATCH",
      body: JSON.stringify(body),
    }, UserDTO);
  }
  logout() {
    return this.req<void>(this.cfg.authBase, "/auth/logout", { method: "POST" });
  }
  /** Organizations the signed-in identity belongs to (for the switcher). */
  myOrgs() {
    return this.req(this.cfg.authBase, "/auth/orgs/mine", {}, z.array(OrgMembershipDTO));
  }
  /** The current org plus any pending deletion. Admin-only. */
  org() {
    return this.req(this.cfg.authBase, "/auth/org", {}, OrgLifecycleDTO);
  }
  /**
   * Schedule this organization for destruction after a grace period.
   *
   * `slug` must equal the org's own slug — typed confirmation, enforced
   * server-side. Every session in the org is revoked immediately, so the caller
   * is signing themselves out too.
   */
  requestOrgDelete(slug: string) {
    return this.req(
      this.cfg.authBase,
      "/auth/org/delete",
      { method: "POST", body: JSON.stringify({ slug }) },
      OrgLifecycleDTO,
    );
  }
  /** Call off a scheduled deletion. Valid until the purge job runs. */
  cancelOrgDelete() {
    return this.req(
      this.cfg.authBase,
      "/auth/org/delete/cancel",
      { method: "POST" },
      OrgLifecycleDTO,
    );
  }
  /** Switch the active organization — returns a fresh session (new access token +
   *  org-scoped user) for the caller's membership in `orgId`, or an
   *  MfaPendingDTO if that membership requires a second factor first (its own
   *  policy, evaluated independently of the org being left). */
  switchOrg(orgId: string) {
    return this.req(
      this.cfg.authBase,
      `/auth/orgs/${orgId}/switch`,
      { method: "POST" },
      LoginResult,
    );
  }
  /**
   * Leave one of the caller's organizations. The membership is marked removed —
   * re-invitable, never deleted — and every session it holds is revoked, so
   * leaving the ACTIVE org means this client must switch to another one.
   *
   * Refused (409, with a message written for the user) when the caller is the
   * org's last admin or when it is their only organization.
   */
  leaveOrg(orgId: string) {
    return this.req<void>(this.cfg.authBase, `/auth/orgs/${orgId}/leave`, {
      method: "POST",
    });
  }

  // ── password reset + email verification ─────────────────────────────────────
  /** Request a reset link. Always resolves the same way (generic 202) whether or
   *  not the email matched — the UI must not reveal account existence. */
  requestPasswordReset(body: { email: string }) {
    return this.req<void>(this.cfg.authBase, "/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /** Cheap validity probe for the reset landing page (does not consume the token). */
  verifyResetToken(token: string) {
    return this.req(
      this.cfg.authBase,
      `/auth/password/reset/verify?token=${encodeURIComponent(token)}`,
      {},
      z.object({ valid: z.boolean() }),
    );
  }
  resetPassword(body: { token: string; password: string }) {
    return this.req<void>(this.cfg.authBase, "/auth/password/reset", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /** Cheap validity probe for the email-verify landing page (does not consume). */
  verifyEmailToken(token: string) {
    return this.req(
      this.cfg.authBase,
      `/auth/email/verify/peek?token=${encodeURIComponent(token)}`,
      {},
      z.object({ valid: z.boolean() }),
    );
  }
  /** Confirm an email address from the emailed verification link (public). */
  verifyEmail(token: string) {
    return this.req<void>(this.cfg.authBase, "/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }
  /** Re-send the verification link for the authenticated caller's own email. */
  resendVerification() {
    return this.req<void>(this.cfg.authBase, "/auth/email/resend", { method: "POST" });
  }

  // ── MFA (TOTP + WebAuthn) ─────────────────────────────────────────────────────
  /** Verify the second factor a pending login is waiting on. Exactly one of
   *  totpCode/backupCode/webauthnCredential should be set. On success this
   *  IS the session — nothing further to call. */
  mfaChallengeVerify(body: {
    pendingToken: string;
    totpCode?: string;
    backupCode?: string;
    webauthnCredential?: unknown;
  }) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/challenge/verify",
      { method: "POST", body: JSON.stringify(body) },
      SessionDTO,
    );
  }
  /** Step-up re-auth (password + a still-valid second factor) to turn MFA off. */
  mfaDisable(body: { password: string; totpCode?: string; backupCode?: string }) {
    return this.req<void>(this.cfg.authBase, "/auth/mfa/disable", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /** Generate a TOTP secret + otpauth:// URI. `pendingToken` only when
   *  authenticating via the restricted enrollment credential (no session yet). */
  mfaTotpEnrollStart(pendingToken?: string) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/totp/enroll/start",
      { method: "POST", body: JSON.stringify({ pendingToken }) },
      MfaTotpEnrollStartResult,
    );
  }
  /** Confirm enrollment: verifies `code` against `secret` and only then
   *  persists it. `session` is set only when reached via the restricted
   *  enrollment credential — otherwise the caller already has one. */
  mfaTotpEnrollConfirm(body: { secret: string; code: string; pendingToken?: string }) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/totp/enroll/confirm",
      { method: "POST", body: JSON.stringify(body) },
      MfaTotpEnrollConfirmResult,
    );
  }
  /** Step-up re-auth; invalidates every unused prior code before minting the
   *  new batch — the old codes stop working immediately. */
  mfaRegenerateBackupCodes(body: { password: string; totpCode?: string; backupCode?: string }) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/totp/backup-codes/regenerate",
      { method: "POST", body: JSON.stringify(body) },
      MfaBackupCodesResult,
    );
  }
  /** WebAuthn registration ceremony options (PublicKeyCredentialCreationOptions,
   *  base64url-encoded per the spec) — feed straight to the enrollment page's
   *  `navigator.credentials.create()` call after decoding. */
  mfaWebauthnRegisterStart(pendingToken?: string) {
    return this.req<Record<string, unknown>>(
      this.cfg.authBase,
      "/auth/mfa/webauthn/register/start",
      { method: "POST", body: JSON.stringify({ pendingToken }) },
    );
  }
  mfaWebauthnRegisterFinish(body: { credential: unknown; nickname?: string; pendingToken?: string }) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/webauthn/register/finish",
      { method: "POST", body: JSON.stringify(body) },
      MfaWebauthnRegisterFinishResult,
    );
  }
  /** WebAuthn authentication ceremony options for a pending login — feed to
   *  `navigator.credentials.get()`, then pass the result as
   *  `mfaChallengeVerify`'s `webauthnCredential`. */
  mfaWebauthnAuthStart(pendingToken: string) {
    return this.req<Record<string, unknown>>(
      this.cfg.authBase,
      "/auth/mfa/webauthn/auth/start",
      { method: "POST", body: JSON.stringify({ pendingToken }) },
    );
  }
  /** The org's mandatory-MFA-for-admins policy + grace-period deadline. */
  orgMfaSettings() {
    return this.req(this.cfg.authBase, "/auth/org/mfa", {}, OrgMfaSettingsDTO);
  }
  setOrgMfaSettings(body: { requireMfaForAdmins: boolean }) {
    return this.req(
      this.cfg.authBase,
      "/auth/org/mfa",
      { method: "POST", body: JSON.stringify(body) },
      OrgMfaSettingsDTO,
    );
  }

  // ── messaging ─────────────────────────────────────────────────────────────────
  conversations() {
    return this.req(this.cfg.messagingBase, "/api/v1/conversations", {}, z.array(ConversationDTO));
  }
  /**
   * Open the 1:1 conversation with `peerId` without sending anything, returning
   * its id. Idempotent — an existing conversation is returned as-is.
   *
   * Use this for every "message this person" affordance. Before it existed, a
   * conversation could only be created by sending a message, so the UI faked a
   * greeting ("👋 Hi Sam!") to force one into existence and the recipient got a
   * message nobody had typed.
   */
  openConversation(peerId: string) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/conversations",
      { method: "POST", body: JSON.stringify({ peerId }) },
      z.object({ conversationId: z.string() }),
    );
  }
  /**
   * One page of conversation history, ascending by seq.
   *
   * Omit beforeSeq for the newest page; pass the lowest seq you already hold to
   * walk backwards. A short page (fewer than `limit` rows) means you have
   * reached the start of the conversation.
   *
   * This used to fetch the entire history on every open — see MESSAGE_PAGE_SIZE.
   */
  messages(conversationId: string, beforeSeq?: number, limit = MESSAGE_PAGE_SIZE) {
    const qs = new URLSearchParams();
    if (typeof beforeSeq === "number") qs.set("beforeSeq", String(beforeSeq));
    qs.set("limit", String(limit));
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/messages?${qs.toString()}`,
      {},
      z.array(MessageDTO),
    );
  }
  /**
   * Send a top-level DM. clientMsgId can be supplied by the caller so the
   * Electron utility process (which serializes sends from sticky widgets)
   * can dedupe across windows; otherwise a fresh UUID is generated here.
   */
  sendMessage(
    recipientId: string,
    body: string,
    clientMsgId?: string,
    kind?: MessageKind,
    /**
     * Which surface is sending. Defaults to "chat" server-side; ONLY the
     * Compose dialog passes "mail", and only mail threads reach the Inbox —
     * that separation is what keeps chat traffic out of it.
     */
    opts?: { origin?: ThreadOrigin; replyToId?: string },
  ) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/conversations/messages",
      {
        method: "POST",
        body: JSON.stringify({
          recipientId,
          body,
          clientMsgId: clientMsgId ?? uuid(),
          kind,
          origin: opts?.origin,
          replyToId: opts?.replyToId,
        }),
      },
      z.object({
        conversationId: z.string(),
        threadId: z.string(),
        messageId: z.string(),
        seq: z.number(),
      }),
    );
  }
  reply(conversationId: string, body: string, clientMsgId?: string, replyToId?: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/reply`,
      { method: "POST", body: JSON.stringify({ body, clientMsgId: clientMsgId ?? uuid(), replyToId }) },
      z.object({ messageId: z.string(), seq: z.number(), threadId: z.string() }),
    );
  }
  /** @deprecated Use ignoreThread(threadId) — kept working for /chats. */
  ignoreConversation(conversationId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/ignore`,
      { method: "POST" },
    );
  }
  /** Hides the complete DM history for this caller only. */
  clearConversation(conversationId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/clear`,
      { method: "POST" },
    );
  }
  read(conversationId: string, upToSeq: number) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/read`,
      { method: "POST", body: JSON.stringify({ upToSeq }) },
    );
  }
  /** Block a user in the 1:1 DM. Gates sends in BOTH directions until unblocked.
   *  The peer sees "You have been blocked". Idempotent (204). */
  blockUser(peerId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/users/${peerId}/block`, {
      method: "POST",
    });
  }
  /** Unblock a user — clears ONLY the caller's block. If the peer also blocked,
   *  the conversation stays blocked until they unblock too. Idempotent (204). */
  unblockUser(peerId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/users/${peerId}/block`, {
      method: "DELETE",
    });
  }

  // ── inbox + threads (post-Phase 3) ───────────────────────────────────────
  /**
   * Unified inbox feed: mail, message threads and tasks intermixed, newest
   * first. When peerId is given, only items with that counterparty are
   * returned.
   *
   * `kinds` narrows it to those item kinds, and belongs on the REQUEST rather
   * than in a filter over the response: a page is a page of rows, so dropping
   * kinds afterwards would leave a caller with a screenful of the wrong kind
   * looking at an empty feed that still claims to have a next page. Omitted
   * means every kind.
   *
   * `deleted` returns the rows the caller has REMOVED instead of the rows they
   * have kept — the Deleted Items folder. Same feed, same cursor, same page
   * shape; only the predicate is inverted. Pass `kinds: ["MAIL"]` with it:
   * hidden means Delete on a mail row but Ignore on a thread or task, and a
   * wastebasket listing every thread you ever ignored is not that folder.
   */
  inbox(
    cursor?: string,
    limit = 25,
    peerId?: string,
    kinds?: InboxItemKind[],
    deleted = false,
  ) {
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    qs.set("limit", String(limit));
    if (peerId) qs.set("peerId", peerId);
    if (kinds?.length) qs.set("kinds", kinds.join(","));
    if (deleted) qs.set("deleted", "1");
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/inbox?${qs.toString()}`,
      {},
      InboxPageDTO,
    );
  }
  /**
   * Distinct counterparties in the caller's inbox (People sidebar).
   *
   * Pass the SAME `kinds` as the feed beside it: this is the badge over that
   * list, and counting rows the list does not show produces a "3" the user
   * cannot find.
   */
  inboxPeers(kinds?: InboxItemKind[]) {
    const qs = kinds?.length ? `?kinds=${kinds.join(",")}` : "";
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/inbox/peers${qs}`,
      {},
      z.array(InboxPeerDTO),
    );
  }
  thread(threadId: string) {
    return this.req(this.cfg.messagingBase, `/api/v1/threads/${threadId}`, {}, ThreadDTO);
  }
  /** Reverse-paginated thread history — 12 messages at a time per design. */
  threadMessages(threadId: string, beforeSeq?: number, limit = 12) {
    const qs = new URLSearchParams();
    if (typeof beforeSeq === "number") qs.set("beforeSeq", String(beforeSeq));
    qs.set("limit", String(limit));
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/threads/${threadId}/messages?${qs.toString()}`,
      {},
      z.array(MessageDTO),
    );
  }
  replyToThread(
    threadId: string,
    body: string,
    opts?: { parentMessageId?: string; clientMsgId?: string; replyToId?: string },
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/threads/${threadId}/reply`,
      {
        method: "POST",
        headers: { "idempotency-key": opts?.clientMsgId ?? uuid() },
        body: JSON.stringify({
          body,
          parentMessageId: opts?.parentMessageId ?? null,
          clientMsgId: opts?.clientMsgId ?? uuid(),
          replyToId: opts?.replyToId,
        }),
      },
      z.object({ messageId: z.string(), seq: z.number() }),
    );
  }
  // ── mail ─────────────────────────────────────────────────────────────────
  //
  // There is no `mailList()`. A mailbox listing is what `inbox()` already
  // serves (rows with itemKind "MAIL"), keyset-paginated with unread rollups —
  // a second parallel list would mean two pagination models over one feed.
  // `mailDrafts()` is the one exception, and only because a draft is in
  // nobody's feed at all: there is no inbox row for it to be a page of.

  /** The Drafts folder — the caller's unsent mail, newest edit first. */
  mailDrafts() {
    return this.req(this.cfg.messagingBase, "/api/v1/mail/drafts", {}, z.array(MailDraftDTO));
  }

  /**
   * Opens a draft and returns its id.
   *
   * Called when the composer OPENS, not on Send: an attachment upload has to be
   * authorized against a destination that already exists, and this id is the
   * `scopeId` those uploads use. Pair every call with `discardMailDraft` on
   * cancel so an abandoned compose does not leave a row behind.
   */
  createMailDraft() {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/mail/drafts",
      { method: "POST" },
      z.object({ mailId: z.string().uuid() }),
    );
  }
  /**
   * Saves what is in the composer onto the draft. Author-only, draft-only.
   *
   * A full overwrite of the draft's contents rather than a patch of changed
   * fields: the composer always knows every field, and a partial update would
   * make "the user cleared the subject" indistinguishable from "the subject was
   * not part of this save". Addresses are stored as typed — a half-written one
   * is expected in a draft, and validation stays at send.
   */
  saveMailDraft(
    mailId: string,
    mail: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyText: string },
  ) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/mail/drafts/${mailId}`, {
      method: "PATCH",
      body: JSON.stringify({
        to: mail.to,
        cc: mail.cc ?? [],
        bcc: mail.bcc ?? [],
        subject: mail.subject,
        bodyText: mail.bodyText,
      }),
    });
  }
  /**
   * Takes one file back off an unsent draft.
   *
   * Necessary rather than cosmetic: Send commits every file still scoped to the
   * mail, so a file only dropped from the composer's tray would go out with it.
   * Reaches the caller's own drafts and nothing else.
   */
  removeDraftAttachment(mailId: string, attachmentId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/mail/drafts/${mailId}/attachments/${attachmentId}`,
      { method: "DELETE" },
    );
  }
  /** Discards an unsent draft and its attachments. Author-only, draft-only. */
  discardMailDraft(mailId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/mail/drafts/${mailId}`, {
      method: "DELETE",
    });
  }
  /**
   * Sends the draft. Addresses are validated and resolved against the org
   * directory server-side: local ones are delivered in-app, the rest are queued
   * for SMTP. A rejected address comes back as a 422 naming that address.
   */
  sendMail(
    mailId: string,
    mail: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyText: string },
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/mail/drafts/${mailId}/send`,
      {
        method: "POST",
        // Send has no natural client-supplied id, so the idempotency key is
        // what stops a double-tap on a slow connection fanning out twice.
        headers: { "idempotency-key": uuid() },
        body: JSON.stringify({
          to: mail.to,
          cc: mail.cc ?? [],
          bcc: mail.bcc ?? [],
          subject: mail.subject,
          bodyText: mail.bodyText,
        }),
      },
      SendMailResultDTO,
    );
  }
  /** The complete email behind an Inbox row. */
  mail(mailId: string) {
    return this.req(this.cfg.messagingBase, `/api/v1/mail/${mailId}`, {}, MailDTO);
  }
  /** Stamps read_at and clears the row's unread badge. Idempotent. */
  readMail(mailId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/mail/${mailId}/read`, {
      method: "POST",
    });
  }

  // ── chat attachments ────────────────────────────────────────────────────────

  /**
   * Uploads one file and returns its metadata.
   *
   * Deliberately does NOT go through `req()`, for two reasons:
   *   - `req()` hard-sets `content-type: application/json`. A multipart upload
   *     must let the BROWSER set the header, because only the browser knows the
   *     boundary it generated for the FormData body.
   *   - fetch has no upload-progress event. XMLHttpRequest does, and a 100 MB
   *     upload with no progress bar is indistinguishable from a hung app.
   *
   * Metadata rides in the query string rather than as form fields so the server
   * can authorize the destination before reading a single byte of the body —
   * form fields arrive interleaved with the file.
   */
  async uploadAttachment(
    scope: AttachmentScope,
    scopeId: string,
    file: Blob,
    opts: {
      filename: string;
      role?: "file" | "thumb";
      parentId?: string;
      width?: number;
      height?: number;
      durationMs?: number;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    },
    retried = false,
  ): Promise<AttachmentDTO> {
    const qs = new URLSearchParams({ scope, scopeId });
    if (opts.role) qs.set("role", opts.role);
    if (opts.parentId) qs.set("parentId", opts.parentId);
    if (opts.width !== undefined) qs.set("width", String(Math.round(opts.width)));
    if (opts.height !== undefined) qs.set("height", String(Math.round(opts.height)));
    if (opts.durationMs !== undefined) qs.set("durationMs", String(Math.round(opts.durationMs)));

    const token = await this.cfg.getToken();
    const url = `${this.cfg.messagingBase}/api/v1/attachments?${qs.toString()}`;

    const form = new FormData();
    form.append("file", file, opts.filename);

    const res = await new Promise<{ status: number; body: unknown; text: string }>(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.withCredentials = true;
        if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
        // No content-type here on purpose — see the doc comment.

        if (opts.onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
          };
        }
        xhr.onload = () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(xhr.responseText);
          } catch {
            parsed = undefined;
          }
          resolve({ status: xhr.status, body: parsed, text: xhr.responseText });
        };
        xhr.onerror = () => reject(new ApiError(0, "network error during upload"));
        xhr.ontimeout = () => reject(new ApiError(408, "upload timed out"));
        xhr.onabort = () => reject(new ApiError(0, "upload cancelled"));

        if (opts.signal) {
          if (opts.signal.aborted) {
            xhr.abort();
          } else {
            opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
          }
        }
        xhr.send(form);
      },
    );

    // Mirror req()'s single silent refresh-and-retry so an access token that
    // expired mid-upload self-heals instead of losing the user's file.
    if (res.status === 401 && token && !retried && this.cfg.refreshToken) {
      const fresh = await this.cfg.refreshToken();
      if (fresh) return this.uploadAttachment(scope, scopeId, file, opts, true);
    }
    if (res.status < 200 || res.status >= 300) {
      const body = res.body as { error?: { message?: string; code?: ErrorCode } } | undefined;
      throw new ApiError(
        res.status,
        body?.error?.message ?? res.text ?? `upload failed (${res.status})`,
        { code: body?.error?.code },
      );
    }

    const parsed = AttachmentDTO.safeParse(res.body);
    if (!parsed.success) {
      console.warn("upload response validation failed", parsed.error.issues);
      throw new ApiError(502, "invalid response from server");
    }
    return parsed.data;
  }

  /**
   * Makes uploaded attachments permanent.
   *
   * Uploads expire after 24h unless committed, because the link between a
   * message and its attachments lives inside an encrypted body the server
   * cannot read — so an abandoned upload can never be discovered as an orphan
   * by inspection. Call this once the message has actually been sent.
   */
  commitAttachment(id: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/attachments/${id}/commit`, {
      method: "POST",
      headers: { "idempotency-key": uuid() },
    });
  }

  /**
   * Mints short-lived signed download URLs.
   *
   * Ids the caller may not read are silently omitted rather than failing the
   * batch: a thread can legitimately contain a forwarded attachment scoped to a
   * conversation the current viewer is not in, and one such id must not blank
   * every image on the page.
   */
  attachmentLinks(ids: string[]) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/attachments/links",
      { method: "POST", body: JSON.stringify({ ids }) },
      z.array(AttachmentLinkDTO),
    );
  }

  /** Absolute URL for a signed link path returned by `attachmentLinks`. */
  mediaUrl(path: string): string {
    return `${this.cfg.messagingBase}${path}`;
  }

  /**
   * Fetches a static map thumbnail for a shared location.
   *
   * Proxied through our own origin so the tile is same-origin (no CSP change in
   * the six places that declare one), the user's IP never reaches the map
   * provider, and the provider key stays server-side.
   *
   * Resolves to null whenever no thumbnail is available — no API key
   * configured, provider down, request timed out. That is a supported state,
   * not an error: the bubble renders a coordinates card instead.
   */
  async staticMap(lat: number, lng: number, zoom = 15): Promise<Blob | null> {
    const qs = new URLSearchParams({
      lat: lat.toFixed(5),
      lng: lng.toFixed(5),
      z: String(zoom),
    });
    const token = await this.cfg.getToken();
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    try {
      const res = await fetch(
        `${this.cfg.messagingBase}/api/v1/maps/static?${qs.toString()}`,
        { headers, credentials: "include" },
      );
      if (res.status === 204 || !res.ok) return null;
      const blob = await res.blob();
      // Guard the render path: only an image may become an object URL for <img>.
      return blob.type.startsWith("image/") ? blob : null;
    } catch {
      return null;
    }
  }

  /**
   * A human-readable name for a coordinate ("12 Rue Foo, Paris"), or null when
   * the deployment has no map provider configured. Used to TAG a shared
   * location so the bubble and the Maps deep link name a place instead of
   * reading "Shared location".
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    const qs = new URLSearchParams({ lat: lat.toFixed(4), lng: lng.toFixed(4) });
    try {
      const out = await this.req(
        this.cfg.messagingBase,
        `/api/v1/maps/reverse?${qs.toString()}`,
        {},
        z.object({ label: z.string() }),
      );
      return out?.label || null;
    } catch {
      // A missing label is cosmetic — never let it block a send.
      return null;
    }
  }

  /**
   * Coarse, IP-derived position for this caller, or null when unavailable.
   *
   * The fallback for desktops where `navigator.geolocation` has no provider to
   * ask — Electron ships without the API key Chromium's network locator needs,
   * and a Linux box has no OS locator either. `accuracy` is deliberately large
   * (city-scale) so the bubble can say so.
   */
  async whereami(): Promise<{ lat: number; lng: number; accuracy: number; label?: string } | null> {
    try {
      return await this.req(
        this.cfg.messagingBase,
        "/api/v1/maps/whereami",
        {},
        z.object({
          lat: z.number(),
          lng: z.number(),
          accuracy: z.number(),
          label: z.string().optional(),
        }),
      );
    } catch {
      return null;
    }
  }

  /** Removes the thread from BOTH users' inbox; revives on next reply. */
  ignoreThread(threadId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/threads/${threadId}/ignore`, {
      method: "POST",
      headers: { "idempotency-key": uuid() },
    });
  }
  /**
   * "Delete for me" — hides one message from THIS user's view only. Either
   * party may do it, for any message; the other side is unaffected and never
   * learns of it.
   */
  hideMessage(messageId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}/hide`, {
      method: "POST",
      headers: { "idempotency-key": uuid() },
    });
  }
  /**
   * "Delete for everyone" — tombstones the message for both parties. SENDER
   * ONLY (the server enforces it). The row survives as a tombstone: `seq`
   * orders the conversation and other tables reference the id, and a reader
   * seeing "this message was deleted" is more honest than a silent gap.
   */
  deleteMessageForAll(messageId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}`, {
      method: "DELETE",
      headers: { "idempotency-key": uuid() },
    });
  }
  /**
   * The batch form of deleteMessageForAll: tombstones every id in
   * messageIds that this caller authored, in one request. Ids the caller
   * did not send come back in `skipped` rather than failing the whole
   * request — the server is the authority on which of a mixed selection it
   * will actually delete. Not idempotency-keyed like the single-message
   * form: its own SQL is idempotent (re-deleting is a no-op), so a retry
   * needs nothing extra to stay safe.
   */
  deleteMessagesForAll(conversationId: string, messageIds: string[]) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/messages/delete`,
      { method: "POST", body: JSON.stringify({ messageIds }) },
      BulkDeleteResultDTO,
    );
  }
  /** Add or remove one emoji reaction. Returns the message's new tally. */
  setReaction(messageId: string, emoji: string, on: boolean) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: on ? "PUT" : "DELETE" },
      z.array(ReactionDTO),
    );
  }
  /**
   * Reactions for ONE PAGE of a conversation, so bubbles and chips render
   * together. Pass the same beforeSeq/limit used for the matching messages()
   * call — the window is what keeps this bounded.
   */
  conversationReactions(
    conversationId: string,
    beforeSeq?: number,
    limit = MESSAGE_PAGE_SIZE,
  ) {
    const qs = new URLSearchParams();
    if (typeof beforeSeq === "number") qs.set("beforeSeq", String(beforeSeq));
    qs.set("limit", String(limit));
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/reactions?${qs.toString()}`,
      {},
      z.array(ReactionDTO),
    );
  }

  // ── Channel message actions ──────────────────────────────────────────────
  // The channel twins of the four methods above. Separate endpoints because
  // channel messages live in their own table, and "delete for everyone" is open
  // to channel moderators as well as the author — see
  // services/messaging-svc/internal/store/channels_message_actions.go.

  /** "Delete for me" in a channel. Invisible to everyone else. */
  hideChannelMessage(messageId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/channel-messages/${messageId}/hide`,
      { method: "POST", headers: { "idempotency-key": uuid() } },
    );
  }
  /**
   * "Delete for everyone" in a channel — a tombstone, like the DM version.
   *
   * Permitted to the AUTHOR or to anyone who moderates the channel (owner,
   * channel admin, org_admin). The server is the authority; the UI only decides
   * whether to offer the option.
   */
  deleteChannelMessageForAll(messageId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/channel-messages/${messageId}`,
      { method: "DELETE", headers: { "idempotency-key": uuid() } },
    );
  }
  /** The batch form of deleteChannelMessageForAll — same contract as
   *  deleteMessagesForAll, scoped to a channel instead of a conversation. A
   *  moderator's batch may authorize every selected message; an ordinary
   *  member's authorizes only their own, with the rest coming back in
   *  `skipped`. */
  deleteChannelMessagesForAll(channelId: string, messageIds: string[]) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/messages/delete`,
      { method: "POST", body: JSON.stringify({ messageIds }) },
      BulkDeleteResultDTO,
    );
  }
  /** Pin or unpin a message for the whole channel. Moderators only. */
  setChannelMessagePin(messageId: string, on: boolean) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/channel-messages/${messageId}/pin`,
      { method: on ? "PUT" : "DELETE" },
    );
  }
  /** Add or remove one emoji reaction on a channel message. Returns its tally. */
  setChannelReaction(messageId: string, emoji: string, on: boolean) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channel-messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: on ? "PUT" : "DELETE" },
      z.array(ReactionDTO),
    );
  }
  /**
   * Reactions for ONE PAGE of a channel. Pass the same beforeSeq/limit used for
   * the matching channelMessages() call — the window is what keeps it bounded.
   */
  channelReactions(channelId: string, beforeSeq?: number, limit = MESSAGE_PAGE_SIZE) {
    const qs = new URLSearchParams();
    if (typeof beforeSeq === "number") qs.set("beforeSeq", String(beforeSeq));
    qs.set("limit", String(limit));
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/reactions?${qs.toString()}`,
      {},
      z.array(ReactionDTO),
    );
  }
  /** Sender-only soft-delete: hides this message from the sender's own inbox. */
  dismissMessage(messageId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}/dismiss`, {
      method: "POST",
      headers: { "idempotency-key": uuid() },
    });
  }
  /** Record a forward the caller is about to make by opening a WhatsApp link,
   *  and write the system entry into the origin chat.
   *
   *  This sends NOTHING and needs no connected WhatsApp Business account — the
   *  caller opens https://wa.me/?text=… and the user sends from their own
   *  WhatsApp. In exchange we cannot observe the outcome, so the recorded
   *  forward is `unconfirmed` and every surface words it that way.
   *
   *  `targetPhone` is optional and normally omitted: with no number in the link,
   *  WhatsApp shows its own contact chooser and the recipient is picked there,
   *  where we cannot see it. Pass one only when the caller genuinely knows the
   *  destination and deep-links straight to that chat.
   *
   *  The caller must build and open the wa.me URL itself: navigation has to
   *  happen synchronously inside the click handler or a popup blocker eats it,
   *  which rules out waiting on this response. Idempotent on clientMsgId. */
  forwardMessageLink(messageId: string, targetPhone?: string, targetName?: string, clientMsgId?: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/messages/${messageId}/forward-link`,
      {
        method: "POST",
        body: JSON.stringify({
          channel: "whatsapp",
          targetPhone: targetPhone ?? "",
          targetName: targetName ?? "",
          clientMsgId: clientMsgId ?? uuid(),
        }),
      },
      z.object({
        status: z.string(),
        platform: z.string(),
        delivery: z.string(),
        /** Empty when the recipient was chosen inside WhatsApp. */
        targetPhone: z.string(),
        systemMessageId: z.string(),
      }),
    );
  }
  /** Forward a message to another chat or channel INSIDE this workspace.
   *
   *  The counterpart to forwardMessageLink, and the one that actually delivers:
   *  the server writes the copy into the destination, RE-SCOPES any attachments
   *  it carries so the recipient can open them, and records the provenance edge
   *  in the same transaction. That re-scoping is why this cannot be done by
   *  re-sending the body from here — an attachment id is authorized against the
   *  conversation it was uploaded to, so a client-side copy would deliver files
   *  the recipient is not allowed to fetch.
   *
   *  Idempotent on clientMsgId: a retry after a dropped connection re-uses the
   *  message the first attempt wrote rather than delivering it twice. */
  forwardMessage(
    messageId: string,
    target: { kind: "user" | "channel"; id: string },
    clientMsgId?: string,
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/messages/${messageId}/forward`,
      {
        method: "POST",
        body: JSON.stringify({
          targetKind: target.kind,
          targetId: target.id,
          clientMsgId: clientMsgId ?? uuid(),
        }),
      },
      z.object({
        messageId: z.string(),
        /** Set for a chat target — the conversation the copy landed in, which
         *  may have been created by this call. */
        conversationId: z.string().optional(),
        /** Set for a channel target. */
        channelId: z.string().optional(),
        /** Always "confirmed" here: the copy is in the database. */
        delivery: z.string(),
      }),
    );
  }
  /**
   * Forward N messages to M destinations in one request — the batch form of
   * forwardMessage. Sources are delivered in `seq` order (the SERVER sorts;
   * it does not trust the array's order) and each destination gets its own
   * transaction, so one destination's refusal does not cost the others —
   * check `results[i].ok` per destination rather than relying on this
   * promise rejecting.
   *
   * `clientBatchId` should be minted ONCE per user action (e.g. once per
   * dialog submission) and reused if that submission is retried: the server
   * derives a stable per-(message, destination) idempotency key from it, so
   * a retry re-uses what already landed instead of duplicating it.
   */
  forwardMessages(input: {
    messageIds: string[];
    targets: { kind: "user" | "channel"; id: string }[];
    clientBatchId?: string;
  }) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/forwards`,
      {
        method: "POST",
        body: JSON.stringify({
          messageIds: input.messageIds,
          targets: input.targets.map((t) => ({ targetKind: t.kind, targetId: t.id })),
          clientBatchId: input.clientBatchId ?? uuid(),
        }),
      },
      BulkForwardResultDTO,
    );
  }
  readThread(threadId: string, upToSeq: number) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/threads/${threadId}/read`, {
      method: "POST",
      body: JSON.stringify({ upToSeq }),
    });
  }
  /** Mark a unified-inbox row "seen" when it's opened. TASK and MAIL rows have
   *  no seq model, so this is the only path that clears their unread badge
   *  (THREAD is routed server-side to the seq-based read; MAIL to the mail's own
   *  read_at). Idempotent + best-effort. */
  readInboxItem(kind: InboxItemKind, refId: string) {
    // Naturally idempotent (unread → 0); mirrors readThread which sends no key.
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/inbox/items/${kind}/${refId}/read`,
      { method: "POST" },
    );
  }
  /**
   * Hide one unified-inbox row for the CALLER.
   *
   * One-sided for MAIL — the sender's Sent copy and every other recipient's are
   * untouched, which is what "delete" means in a mail client. THREAD has a
   * two-sided ignore of its own (`ignoreThread`) and should use that; TASK must
   * go through `taskAction(id, "ignore")` so the state machine actually runs,
   * because this endpoint only hides the projection row.
   */
  ignoreInboxItem(kind: InboxItemKind, refId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/inbox/items/${kind}/${refId}/ignore`,
      { method: "POST", headers: { "idempotency-key": uuid() } },
    );
  }
  /**
   * Puts a deleted mail back in the folder it came from — the undo of
   * `ignoreInboxItem("MAIL", …)`.
   *
   * MAIL only, server-side too. Deleting a mail only ever set a flag on the
   * caller's feed row, so there is nothing else to reverse: the same mail, with
   * the same read state, reappears where it was.
   */
  restoreMail(refId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/inbox/items/MAIL/${refId}/restore`,
      { method: "POST", headers: { "idempotency-key": uuid() } },
    );
  }

  // ── tasks ──────────────────────────────────────────────────────────────────────
  createTask(body: {
    title: string;
    description: string;
    assigneeIds?: string[];
    /** Optional: allocate to a channel. Server resolves the channel's
     *  current members and fans the task out to each. Future joiners are
     *  auto-added via the ChannelMemberJoined consumer in task-svc.
     *  When set, `assigneeIds` is ignored — server is the source of truth. */
    channelId?: string;
  }) {
    return this.req(this.cfg.taskBase, "/api/v1/tasks", {
      method: "POST",
      headers: { "idempotency-key": uuid() },
      body: JSON.stringify(body),
    }, z.object({ taskId: z.string() }));
  }
  taskInbox() {
    return this.req(this.cfg.taskBase, "/api/v1/tasks/inbox", {}, z.array(StickyTaskDTO));
  }
  taskAssigned() {
    return this.req(this.cfg.taskBase, "/api/v1/tasks/assigned", {}, z.array(StickyTaskDTO));
  }
  tasksSticky() {
    return this.req(this.cfg.taskBase, "/api/v1/tasks/sticky", {}, z.array(StickyTaskDTO));
  }
  /** Single task assigned to me at ANY status — used by the inbox detail view so
   *  a terminal (completed/ignored/left) task opened from the unified inbox
   *  resolves from the server instead of 404-ing on a cache miss. */
  taskDetail(taskId: string) {
    return this.req(this.cfg.taskBase, `/api/v1/tasks/${taskId}/detail`, {}, StickyTaskDTO);
  }
  tasksSent() {
    return this.req(this.cfg.taskBase, "/api/v1/tasks/sent", {}, z.array(SentTaskDTO));
  }
  taskAction(taskId: string, action: "acknowledge" | "complete" | "ignore" | "leave") {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/${taskId}/assignees/me/${action}`,
      { method: "POST", headers: { "idempotency-key": uuid() } },
      z.object({ status: z.string(), statusVersion: z.number() }),
    );
  }
  /** Allocator writes/updates a review on a COMPLETED assignee. Sender-only;
   *  editable (re-post overwrites). */
  reviewTask(taskId: string, assigneeId: string, body: { text: string; rating?: number | null }) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/${taskId}/assignees/${assigneeId}/review`,
      { method: "POST", body: JSON.stringify(body) },
      ReviewResponse,
    );
  }
  /**
   * Export the caller's task timeline as rows (one per (task, assignee)). scope
   * selects tasks I allocated ("sent"), tasks allocated to me ("received"), or
   * both ("all"). from/to are ISO-8601 UTC instants the CLIENT computes from the
   * user's local-tz date range; omit both for "all time". The client builds the
   * .xlsx from these rows (joining names+emails from the directory).
   */
  exportTasks(params: { scope: "sent" | "received" | "all"; from?: string; to?: string }) {
    const qs = new URLSearchParams({ scope: params.scope });
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/export?${qs.toString()}`,
      {},
      z.array(TaskExportRow),
    );
  }

  /** Inputs for the "Available" bucket: per-user OPEN task counts + the set of
   *  users an org admin hid from the roster. Counts only — the member list comes
   *  from `directory()` and is joined client-side. */
  taskAvailability() {
    return this.req(this.cfg.taskBase, "/api/v1/tasks/availability", {}, AvailabilityDTO);
  }
  /** Admin-only: hide a user from the Available roster, org-wide. Idempotent;
   *  403 for a plain member. */
  hideAvailableUser(userId: string) {
    return this.req<void>(this.cfg.taskBase, "/api/v1/tasks/availability/hidden", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }
  /** Admin-only: restore a hidden user to the roster. Idempotent. */
  unhideAvailableUser(userId: string) {
    return this.req<void>(
      this.cfg.taskBase,
      `/api/v1/tasks/availability/hidden/${userId}`,
      { method: "DELETE" },
    );
  }

  // ── channels (group chat, served by messaging-svc) ──────────────────────────────
  channels() {
    return this.req(this.cfg.messagingBase, "/api/v1/channels", {}, z.array(ChannelDTO));
  }
  /** One page of the directory of OPEN channels the caller isn't already a
   *  member of. Used by the "Browse channels" view in the Channels sidebar.
   *
   *  PAGED, and it has to be: this lists every open channel in the ORGANISATION,
   *  not just the caller's, so its size is set by how big the customer is. The
   *  server clamps `limit` (default 50, max 200) and returns fewer rows than
   *  asked for only at the end of the directory — which is how the caller knows
   *  to stop. */
  openChannels(opts: { limit?: number; offset?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/open${qs ? `?${qs}` : ""}`,
      {},
      z.array(ChannelDTO),
    );
  }
  createChannel(body: { name: string; memberIds: string[]; isLocked?: boolean }) {
    return this.req(this.cfg.messagingBase, "/api/v1/channels", {
      method: "POST",
      body: JSON.stringify({ isLocked: false, ...body }),
    }, ChannelDTO);
  }
  renameChannel(channelId: string, name: string) {
    return this.req<ChannelDTO>(this.cfg.messagingBase, `/api/v1/channels/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }, ChannelDTO);
  }
  deleteChannel(channelId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/channels/${channelId}`, {
      method: "DELETE",
    });
  }
  joinChannel(channelId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/channels/${channelId}/join`, {
      method: "POST",
    });
  }
  leaveChannel(channelId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/channels/${channelId}/leave`, {
      method: "POST",
    });
  }
  clearChannel(channelId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/channels/${channelId}/clear`, {
      method: "POST",
    });
  }
  /**
   * One page of channel history, ascending by seq. Same contract as messages().
   */
  channelMessages(channelId: string, beforeSeq?: number, limit = MESSAGE_PAGE_SIZE) {
    const qs = new URLSearchParams();
    if (typeof beforeSeq === "number") qs.set("beforeSeq", String(beforeSeq));
    qs.set("limit", String(limit));
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/messages?${qs.toString()}`,
      {},
      z.array(ChannelMessageDTO),
    );
  }
  markChannelRead(channelId: string, upToSeq: number) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/channels/${channelId}/read`, {
      method: "POST",
      body: JSON.stringify({ upToSeq }),
    });
  }
  /**
   * Who has read each of `messageIds` in this channel.
   *
   * The ids ride in the query string, so the caller cannot be allowed to decide
   * how many there are: the thread grows every time "Load older" runs, and a
   * few hundred UUIDs is a URL long enough for a proxy to reject outright. The
   * NEWEST are kept, matching the server's own cap — receipts on the message
   * somebody just sent are the ones anybody looks at.
   */
  channelReadReceipts(channelId: string, messageIds: string[]) {
    const qs = new URLSearchParams({
      messageIds: messageIds.slice(-CHANNEL_RECEIPT_IDS_MAX).join(","),
    });
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/receipts?${qs.toString()}`,
      {},
      z.array(ChannelReadReceiptDTO),
    );
  }
  sendChannelMessage(channelId: string, body: string, clientMsgId?: string, kind?: MessageKind) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/messages`,
      { method: "POST", body: JSON.stringify({ body, clientMsgId: clientMsgId ?? uuid(), kind }) },
      z.object({ messageId: z.string(), seq: z.number() }),
    );
  }
  addChannelMembers(channelId: string, memberIds: string[]) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/channels/${channelId}/members`, {
      method: "POST",
      body: JSON.stringify({ memberIds }),
    });
  }
  /** Member user ids for a channel. Caller must be a member themselves. Used
   *  by the task dialog to expand "Assign to channel" into a multi-assignee
   *  task on the server. */
  channelMembers(channelId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/members`,
      {},
      z.array(z.string()),
    );
  }

  // ── presence (ws-gateway HTTP) ────────────────────────────────────────────────

  /**
   * Every online member of the caller's organisation.
   *
   * PREFER `presenceOf` BELOW. This reads one Redis key per organisation, so
   * both its size and its read rate scale with how large the customer is — and
   * that is the one part of the keyspace sharding cannot relieve, because a key
   * lives on one node however many nodes there are. Three screens polling it
   * every 20 seconds meant a 10,000-seat org re-read a 10,000-member sorted set
   * hundreds of times a second to render a few dozen avatars.
   *
   * Kept because the endpoint is still served and some callers (an admin-wide
   * directory view) genuinely want the whole set.
   */
  presence() {
    return this.req(this.cfg.presenceBase, "/presence", {}, z.array(z.string()));
  }

  /**
   * Which of THESE people are online.
   *
   * The bounded counterpart to `presence`, and what every list view should use.
   * It reads per-user keys, which are hash-tagged by user id and therefore
   * shard evenly, so the cost scales with what is on screen rather than with
   * the size of the organisation.
   *
   * POST because the id list IS the request; a few hundred ids do not belong in
   * a query string. Returns the subset that is online, in no particular order.
   */
  /**
   * Everyone in the org who is in a LIVE call right now.
   *
   * Merged with presence to render "Busy" rather than "Online" — being
   * connected and being interruptible are different questions, and answering
   * the second with the first is worse than saying nothing, because a colleague
   * acts on it.
   *
   * Unbounded, unlike `presenceOf`: this scales with concurrent call
   * participants rather than with the size of the organisation.
   */
  onCallUserIds() {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/calls/on-call",
      {},
      z.array(z.string().uuid()),
    );
  }
  presenceOf(userIds: string[]) {
    // Nothing asked for, nothing to ask. Saves a round trip on every render
    // that happens before its list has loaded — which, with react-query, is
    // most first renders.
    if (userIds.length === 0) return Promise.resolve([] as string[]);
    return this.req(
      this.cfg.presenceBase,
      "/presence/query",
      { method: "POST", body: JSON.stringify({ userIds }) },
      z.array(z.string()),
    );
  }

  // ── TURN/ICE credentials for WebRTC calls (ws-gateway HTTP) ───────────────────
  // Short-lived HMAC creds minted per-request; the client fetches fresh ones
  // right before placing/accepting a call so a credential is never stale.
  turnCredentials() {
    return this.req(
      this.cfg.presenceBase,
      "/turn-credentials",
      {},
      z.object({
        iceServers: z.array(
          z.object({
            urls: z.array(z.string()),
            username: z.string().optional(),
            credential: z.string().optional(),
          }),
        ),
        ttl: z.number().optional(),
      }),
    );
  }

  // ── notifications ───────────────────────────────────────────────────────────────
  notifications() {
    return this.req(this.cfg.notificationBase, "/api/v1/notifications", {}, z.array(NotificationDTO));
  }
  markNotificationRead(id: string) {
    return this.req<void>(this.cfg.notificationBase, `/api/v1/notifications/${id}/read`, {
      method: "POST",
    });
  }
  /** Mark every unread notification read in one call — used to auto-clear the
   *  bell when the notifications panel is opened. Idempotent + best-effort. */
  readAllNotifications() {
    return this.req<void>(this.cfg.notificationBase, "/api/v1/notifications/read-all", {
      method: "POST",
    });
  }

  // ── Calls ──────────────────────────────────────────────────────────────
  //
  // Three shapes over one entity. The differences are entirely about where the
  // roster comes from — see CallKind in types/domain.ts.

  /** Schedule a call in a channel, or start one now by omitting scheduledAt.
   *  Everyone in the channel is implicitly invited; there is no link. */
  scheduleChannelCall(
    channelId: string,
    body: {
      title?: string;
      media?: "audio" | "video";
      scheduledAt?: string;
      durationMinutes?: number;
    },
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/calls`,
      { method: "POST", body: JSON.stringify(body) },
      CallDTO,
    );
  }

  /** Calls scheduled or live in a channel. */
  channelCalls(channelId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/calls`,
      {},
      z.array(CallDTO),
    );
  }

  /** Schedule a meeting. inviteeIds are same-org users placed on the roster up
   *  front; anyone else — including people in other orgs — arrives by link. */
  scheduleMeeting(body: {
    title?: string;
    media?: "audio" | "video";
    scheduledAt?: string;
    /** How long it should run. Omit for the server's default hour on a
     *  scheduled meeting, or for no scheduled end at all on a "meet now".
     *  The server ends the call when this elapses. */
    durationMinutes?: number;
    inviteeIds?: string[];
  }) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/meetings",
      { method: "POST", body: JSON.stringify(body) },
      CallDTO,
    );
  }

  /** Every call the caller is expected at, including meetings hosted by
   *  another organisation. */
  myCalls() {
    return this.req(this.cfg.messagingBase, "/api/v1/calls", {}, z.array(CallDTO));
  }

  call(callId: string) {
    return this.req(this.cfg.messagingBase, `/api/v1/calls/${callId}`, {}, CallDTO);
  }

  /** Finished meetings the caller was in, newest first, paged.
   *
   *  Deliberately NOT `myCalls()` with a bigger limit. That one answers "what
   *  am I expected at" and caps its history at a month, which is right for
   *  Upcoming and Live and silently truncates a Past list. This has no day cap
   *  and no end, so it has a cursor: pass `nextCursor` back to continue. */
  myCallHistory(cursor?: string, limit?: number) {
    const q = new URLSearchParams();
    if (cursor) q.set("cursor", cursor);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/history${qs ? `?${qs}` : ""}`,
      {},
      CallPageDTO,
    );
  }

  /** A meeting's chat transcript, OLDEST first — a conversation is read
   *  forwards. Room-wide messages only; see CallChatMessageDTO. */
  callChat(callId: string, cursor?: string, limit?: number) {
    const q = new URLSearchParams();
    if (cursor) q.set("cursor", cursor);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/chat${qs ? `?${qs}` : ""}`,
      {},
      CallChatPageDTO,
    );
  }

  /** Keep one room-wide chat message against the meeting.
   *
   *  `id` and `at` are the ones the data-channel copy already carries, so the
   *  stored line and the one everybody saw live are the same entry — and a
   *  retry is one row, not two. Called ONLY for a message addressed to
   *  everyone: a directed message stays on the wire, where its audience is
   *  what the sender chose. */
  saveCallChat(callId: string, entry: { id: string; text: string; at: number }) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/chat`,
      { method: "POST", body: JSON.stringify(entry) },
      CallChatMessageDTO,
    );
  }

  /** A meeting's shared notes, oldest first. */
  callNotes(callId: string, cursor?: string, limit?: number) {
    const q = new URLSearchParams();
    if (cursor) q.set("cursor", cursor);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/notes${qs ? `?${qs}` : ""}`,
      {},
      CallNotePageDTO,
    );
  }

  /** Keep one shared note against the meeting. Same id/at contract as
   *  saveCallChat. */
  saveCallNote(callId: string, entry: { id: string; text: string; at: number }) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/notes`,
      { method: "POST", body: JSON.stringify(entry) },
      CallNoteDTO,
    );
  }

  /** Back a 1:1 ring with a persistent call, so it can later be widened. */
  startDirectCall(peerId: string, media: "audio" | "video" = "video") {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/calls/direct",
      { method: "POST", body: JSON.stringify({ peerId, media }) },
      CallDTO,
    );
  }

  /** Schedule a call in a one-to-one chat, the way a channel or a meeting can
   *  already be scheduled. The peer must be in your org.
   *
   *  Like every other scheduled call it lands behind the waiting room: the peer
   *  who opens it early waits until you start it. */
  scheduleDirectCall(
    peerId: string,
    body: {
      scheduledAt: string;
      title?: string;
      media?: "audio" | "video";
      durationMinutes?: number;
    },
  ) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/calls/direct",
      { method: "POST", body: JSON.stringify({ peerId, ...body }) },
      CallDTO,
    );
  }

  /** Start a scheduled call, admitting everyone waiting on it in one go.
   *
   *  Restricted to the people who can open it: whoever scheduled it (and any
   *  host they appointed), an org admin, or an owner/admin of the channel a
   *  channel call belongs to. `canStart` on the waiting-room response says
   *  whether the current user is one of them.
   *
   *  Idempotent — starting a call that is already live is not an error. */
  startCall(callId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/start`,
      { method: "POST" },
      CallDTO,
    );
  }

  /** Announce that you have begun sharing your screen.
   *
   *  The picture itself goes to the SFU on the connection the room token already
   *  authorised; this is what makes the ROOM agree on who is sharing and what
   *  they picked, so someone joining mid-share is told rather than left to infer
   *  it. Pass the browser's own `displaySurface` ("monitor" | "window" |
   *  "browser") or the server's names — both are accepted. */
  startScreenShare(callId: string, source: CallShareSource | "monitor" | "window" | "browser") {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/share`,
      { method: "POST", body: JSON.stringify({ source }) },
      CallShareDTO,
    );
  }

  /** Stop sharing YOUR screen.
   *
   *  There is deliberately no user argument, and no endpoint that takes one:
   *  the stop control belongs to the person sharing, so no other participant
   *  can construct a request that ends your share. Leaving or ending the call
   *  stops it too. */
  stopScreenShare(callId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/share/stop`, {
      method: "POST",
    });
  }

  /** Pull another member of YOUR org into a call already in progress. The
   *  server refuses a user from a different org here — cross-org entry exists
   *  only via a meeting link. */
  addCallParticipant(callId: string, userId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/participants`,
      { method: "POST", body: JSON.stringify({ userId }) },
      CallDTO,
    );
  }

  /** Mint a meeting join link. MEETINGS ONLY — asking for one on a channel call
   *  is a 400, because a channel call has no guest list to extend.
   *
   *  The returned token is shown once and never stored in recoverable form. */
  createCallInvite(callId: string, opts?: { ttlSeconds?: number; maxUses?: number }) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/invites`,
      {
        method: "POST",
        body: JSON.stringify({
          ttlSeconds: opts?.ttlSeconds,
          maxUses: opts?.maxUses ?? null,
        }),
      },
      CallInviteDTO,
    );
  }

  /** The recording of a finished call, with a short-lived signed playback path
   *  in `url`.
   *
   *  Only worth calling when `call.recordingStatus` is "READY" — a call
   *  with no recording answers 404, which is a state and not a failure. The
   *  link expires (MEDIA_URL_TTL_SECONDS), so hold the result no longer than
   *  the playback it was fetched for. */
  callRecording(callId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/recording`,
      {},
      CallRecordingDTO,
    );
  }

  /** Start recording this call. HOSTS ONLY — the server refuses everyone else,
   *  and answers 503 on a deployment with no recording worker, which the room
   *  reports as "recording isn't enabled here" rather than as a failure. */
  startCallRecording(callId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/recording/start`,
      { method: "POST" },
      z.object({ recordingStatus: CallRecordingStatus }),
    );
  }

  /** Stop it. Idempotent: stopping a call nobody is recording is not an error. */
  stopCallRecording(callId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/recording/stop`, {
      method: "POST",
    });
  }

  revokeCallInvite(callId: string, inviteId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/invites/${inviteId}`,
      { method: "DELETE" },
    );
  }

  /** Redeem a meeting link. Works across organisations: the caller still has to
   *  be a signed-in BlissWork user, but their org is irrelevant — holding a live
   *  token is the whole grant. */
  joinCallByToken(token: string) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/calls/join",
      { method: "POST", body: JSON.stringify({ token }) },
      CallDTO,
    );
  }

  /** Ask to enter a call. POST, not GET: it mints a short-lived credential and
   *  re-checks access every time, so it must never be cached.
   *
   *  TWO outcomes, discriminated by `state`:
   *
   *    JOINED   a room token. The call is under way.
   *    WAITING  the waiting room, and no token, because the call has not been
   *             started by anyone entitled to start it. Call it again when the
   *             `call.started` event arrives over the websocket — that is what
   *             normally ends the wait. A client in the lobby ALSO keeps a slow
   *             timer, but only to cover a socket that is down: re-deciding
   *             access is not free, and a large meeting waiting on a late host
   *             is as many lobbies as there are people in it.
   *
   *  The absence of a token in the WAITING case is the actual enforcement, not
   *  the lobby screen: there is nothing to open the room with until someone
   *  starts the call. */
  callToken(callId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/token`,
      { method: "POST" },
      CallJoinDTO,
    );
  }

  /** Reports a client-observed WebRTC reconnect after a transient disruption
   *  (LiveKit's `Reconnected` room event) — see messaging-svc's
   *  metrics/calls.go for why this cannot be derived server-side. Fire-and-
   *  forget from the caller's point of view: a failed telemetry POST must
   *  never affect the call itself. */
  callTelemetryReconnected(callId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/telemetry`, {
      method: "POST",
      body: JSON.stringify({ event: "reconnected" }),
    });
  }

  /** Reports how long THIS client measured from requesting callId's token to
   *  its LiveKit Room reporting Connected. See callTelemetryReconnected's
   *  comment — same fire-and-forget contract. */
  callTelemetrySetupComplete(callId: string, setupMs: number) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/telemetry`, {
      method: "POST",
      body: JSON.stringify({ event: "setup_complete", setupMs }),
    });
  }

  leaveCall(callId: string) {
    // keepalive: this fires from a "Leave" click that can be followed almost
    // immediately by a tab close (the standalone /call/:id tab closes itself
    // right after leave() resolves) — without it, a fast enough close can
    // abort this request before the server ever records the departure. The
    // body is empty, nowhere near the 64KB keepalive cap.
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/leave`, {
      method: "POST",
      keepalive: true,
    });
  }

  /** End the call for everyone. Hosts only; also revokes every outstanding
   *  join link, so a meeting that is over cannot be re-entered by an old link. */
  endCall(callId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/end`, {
      method: "POST",
    });
  }

}

export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly requestId: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    public readonly status: number,
    message: string,
    opts: { code?: ErrorCode; requestId?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = opts.code ?? httpStatusToCode(status);
    this.requestId = opts.requestId ?? "";
    this.details = opts.details;
  }

  static async fromResponse(res: Response): Promise<ApiError> {
    const requestId = res.headers.get("x-request-id") ?? "";
    const text = await res.text().catch(() => "");
    if (!text) {
      return new ApiError(res.status, res.statusText || "request failed", { requestId });
    }
    try {
      const body = JSON.parse(text) as Partial<ApiErrorBody>;
      const err = body.error;
      if (err && typeof err === "object") {
        return new ApiError(res.status, err.message ?? res.statusText, {
          code: err.code,
          requestId: err.requestId || requestId,
          details: err.details,
        });
      }
    } catch {
      // body wasn't JSON — fall through with the raw text
    }
    return new ApiError(res.status, text, { requestId });
  }
}
