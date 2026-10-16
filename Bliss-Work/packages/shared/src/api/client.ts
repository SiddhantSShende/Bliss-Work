/**
 * Thin typed REST client. One instance per app; talks to all services through
 * the per-service base URLs (no API gateway in MVP). Access token is supplied
 * by a getter so it can live in memory (web) or the Electron secure store.
 */
import { z } from "zod";
import { logger } from "../logging";
import {
  AttachmentDTO,
  AttachmentLinkDTO,
  type AttachmentScope,
  ActivityExportRow,
  ActiveSessionDTO,
  ActivitySessionPage,
  ActivitySummaryDTO,
  AuditPage,
  ConnectIntegrationResultDTO,
  IntegrationConnectionDTO,
  AvailabilityDTO,
  BulkDeleteResultDTO,
  BulkForwardResultDTO,
  CaptchaChallengeDTO,
  CallDTO,
  MeetingRecurrenceInput,
  MeetingSeriesDTO,
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
  CustomThemeDTO,
  type DeadlineRule,
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
  I18nCatalogDTO,
  I18nLanguagesDTO,
  MfaTotpEnrollStartResult,
  type ThreadOrigin,
  NotificationDTO,
  NotificationPageDTO,
  type NotificationReadTarget,
  OrgMembershipDTO,
  OrgMembershipPageDTO,
  OrgLifecycleDTO,
  OrgMfaSettingsDTO,
  ReviewResponse,
  ProjectDTO,
  ScheduledTaskDTO,
  SentTaskDTO,
  StickyTaskDTO,
  TaskExportRow,
  TaskDiscussionDTO,
  TaskDiscussionSummaryDTO,
  TaskAnalyticsDTO,
  ChannelAnalyticsDTO,
  ProjectAnalyticsDTO,
  WorkspaceOverviewDTO,
  OrgActivitySummaryDTO,
  ThreadDTO,
  TimelinePage,
  ThemePrefsDTO,
  UserDTO,
  SessionDTO,
} from "../types/domain";
import {
  ApiErrorBody,
  ErrorCode,
  httpStatusToCode,
} from "../types/errors";
import type { GraphqlOperationName } from "../graphql/operations";
import type { ClientPlatform } from "../policy/clientPlatform";

export interface ApiConfig {
  authBase: string; // e.g. http://localhost:8001
  taskBase: string; // e.g. http://localhost:8002
  messagingBase: string; // e.g. http://localhost:8004
  telemetryBase: string; // member activity record, e.g. http://localhost:8006
  notificationBase: string; // notifications are served by task/notification svc
  presenceBase: string; // ws-gateway HTTP, e.g. http://localhost:8090
  /**
   * integrations-svc — connected-account OAuth (Settings > Microsoft 365).
   *
   * OPTIONAL, same reasoning as stickyBase/graphBase below: mobile has no
   * Settings surface for this yet, so its platform config simply omits it.
   * Every method that needs it treats an absent base as "feature
   * unavailable on this platform" rather than throwing.
   */
  integrationsBase?: string; // e.g. http://localhost:8005
  /**
   * sticky-svc, e.g. http://localhost:8008 — the durable record of which task
   * notes belong on this user's desktop.
   *
   * OPTIONAL, and deliberately so. Everything about the desktop notes works
   * without it, exactly as it did before this service existed: task-svc's
   * /api/v1/tasks/sticky is still the content source and still decides which
   * tasks are actionable. This adds durability (a pin survives a reinstall and
   * follows the user to a second machine) and delivery tracking. A build with
   * this unset — including every desktop installer already in the field — takes
   * the old path and is unaffected.
   */
  stickyBase?: string;
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
  /**
   * Which process constructed this client ("web", "electron", "electron-utility",
   * …) — surfaced only in the temporary authDiag log below, to tell apart the
   * renderer's own ApiClient from the Electron utility process's separate one
   * (apps/desktop/src/main/ws-process.ts) when correlating a failing request.
   * Omit outside that investigation; it has no effect on requests themselves.
   */
  clientId?: string;
}

/**
 * TEMPORARY diagnostic for the "missing bearer token" investigation (messaging
 * channel/reaction/conversation requests 401ing while others on the same page
 * succeed). Logs only non-secret request metadata — method, path, a boolean for
 * whether a well-formed `Bearer ` header was attached, the correlation id this
 * same request carries server-side (jwtauth.go logs the identical id), and the
 * eventual response status. NEVER the token, cookies, or message content.
 *
 * Remove this block (and the `x-request-id`/clientId plumbing around it in
 * `req()`) once the root cause is confirmed — it is not meant to ship long-term.
 */
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
    "call_session_active",
    "call_ended",
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

const StickyPinStateSchema = z.enum(["PINNED", "UNPINNED"]);
/** sticky-svc's answer to PUT/DELETE /sticky/pins/{taskId}. `state` is CLOSED
 *  once the task has finished — the lifecycle's doing, never an Unpin. */
const StickyPinStateResult = z.object({
  taskId: z.string(),
  state: z.enum(["PINNED", "UNPINNED", "CLOSED"]),
  updatedAt: z.string(),
});
export type StickyPinStateResult = z.infer<typeof StickyPinStateResult>;
/** Mirrors the largest page task-svc will serve (_MAX_LIMIT in tasks_read.py). */
const TASK_LIST_PAGE_SIZE = 100;
/** 2,000 tasks; past that the list is truncated rather than fetched without end. */
const TASK_LIST_MAX_PAGES = 20;

/**
 * Ids get spliced straight into request paths (`/auth/members/${userId}`,
 * `/api/v1/calls/${callId}`, ...). A crafted id containing a dot-segment —
 * raw, percent-encoded, or backslash-separated (http(s) URL parsing treats a
 * backslash as "/") — must not be able to redirect the request to a
 * different endpoint on the same origin. `req()` checks every outgoing path
 * here rather than trusting each of the ~100 id-interpolated methods above
 * to sanitize its own argument.
 *
 * Only the path portion (before `?`/`#`) is checked, and only whole segments
 * are rejected — a legitimate id containing dots (`a..b`) or a query string
 * with dots is untouched.
 */
function assertSafeRequestPath(path: string): void {
  const pathname = path.split(/[?#]/, 1)[0] ?? path;
  for (const segment of pathname.split(/[/\\]/)) {
    if (segment === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed percent-encoding is itself untrusted-looking input.
      throw new ApiError(400, "invalid request path segment");
    }
    if (decoded === "." || decoded === "..") {
      throw new ApiError(400, "invalid request path segment");
    }
  }
}

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
    assertSafeRequestPath(path);
    const token = await this.cfg.getToken();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    };
    if (token) headers["authorization"] = `Bearer ${token}`;

    // Preserve the support-correlation id across auth retries without logging
    // request metadata or payloads in the browser console.
    const requestId =
      (init.headers as Record<string, string> | undefined)?.["x-request-id"] ??
      (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    headers["x-request-id"] = requestId;

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
      if (fresh) {
        // Carry the same support-correlation id into the retry.
        const retryInit = { ...init, headers: { ...(init.headers as Record<string, string>), "x-request-id": requestId } };
        return this.req<T>(base, path, retryInit, schema, true);
      }
    }
    if (!res.ok) {
      throw await ApiError.fromResponse(res);
    }
    if (res.status === 204) return undefined as T;
    if (schema) {
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) {
        logger.warn("response validation failed", { issueCount: parsed.error.issues.length });
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
      logger.warn("graphql partial result", {
        operationName,
        errorCount: envelope.errors.length,
        errorCodes: envelope.errors.map((error) => asErrorCode(error.extensions?.code)).filter(Boolean),
      });
    }

    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) {
      logger.warn("graphql response validation failed", {
        operationName,
        issueCount: parsed.error.issues.length,
      });
      throw new ApiError(502, "invalid response from the GraphQL gateway");
    }
    return parsed.data;
  }

  // ── auth / org / invite ─────────────────────────────────────────────────────
  /** A fresh CAPTCHA challenge — required on both createOrg and login. Calling
   *  this again (e.g. the form's "refresh" button, or after a failed attempt)
   *  mints a completely new captchaId/image. Pass the id being discarded as
   *  `replaces` and the server invalidates it, so a refresh never leaves two
   *  answerable challenges (omit it on the first load). */
  getCaptcha(replaces?: string) {
    const qs = replaces ? `?replaces=${encodeURIComponent(replaces)}` : "";
    return this.req(this.cfg.authBase, `/auth/captcha${qs}`, {}, CaptchaChallengeDTO);
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
   *  a session.
   *
   *  `captchaId`/`captchaValue` may be omitted only by a client that declares an
   *  exempt `clientPlatform` (see policy/clientPlatform.ts); the server still
   *  decides, and answers 400 if it wants the CAPTCHA anyway. */
  login(body: {
    email: string;
    password: string;
    captchaId?: string;
    captchaValue?: string;
    clientPlatform?: ClientPlatform;
  }) {
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
  createInvite(body: { email: string; role: Role }) {
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
  /**
   * One page of the directory, optionally narrowed by a search.
   *
   * For pickers, which must not download the organisation to show a dozen rows.
   * `q` matches display name, username and email (case-insensitive substring) and
   * `offset` then counts MATCHES, so a search pages exactly as the whole directory
   * does. A page shorter than `limit` is the end. Against a server that predates
   * `q` the parameter is ignored and the page is the unfiltered directory — callers
   * that show results should also filter what comes back (see lib/matchUser).
   */
  directoryPage(opts: { q?: string; limit?: number; offset?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.q?.trim()) q.set("q", opts.q.trim());
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return this.req(this.cfg.authBase, `/auth/directory${qs ? `?${qs}` : ""}`, {}, z.array(UserDTO));
  }

  // ── active sessions (sign-in sessions, not activity/telemetry ones) ────────
  /** The caller's own active sessions in their current org. `isCurrent` marks
   *  the one this very request is authenticated by, where the server could
   *  tell (web only — see auth-svc's routes/sessions.py). */
  listSessions() {
    return this.req(this.cfg.authBase, "/auth/sessions", {}, z.array(ActiveSessionDTO));
  }
  /** Revoke one of the caller's own sessions. 404s (never 403) on a session
   *  that isn't the caller's — see the server's own note on why that
   *  ambiguity is deliberate. */
  revokeSession(id: string) {
    return this.req<void>(this.cfg.authBase, `/auth/sessions/${id}`, { method: "DELETE" });
  }
  /** Revoke every one of the caller's OTHER sessions in one call. Pass the
   *  current session's id (decode it from the access token's own `sid`
   *  claim — see `decodeJwtPayload`) to keep it signed in; omit it to sign
   *  out everywhere, including this session. Returns the ids revoked. */
  revokeOtherSessions(currentSessionId?: string) {
    return this.req(this.cfg.authBase, "/auth/sessions/revoke-others", {
      method: "POST",
      body: JSON.stringify({ currentSessionId: currentSessionId ?? null }),
    }, z.array(z.string()));
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
  /** A member's active sessions — org_admin only. No `isCurrent`: this is
   *  never the admin's own session (self-revoking here is refused server-side
   *  — use `revokeSession` instead). */
  listMemberSessions(userId: string) {
    return this.req(this.cfg.authBase, `/auth/members/${userId}/sessions`, {}, z.array(ActiveSessionDTO));
  }
  revokeMemberSession(userId: string, sessionId: string) {
    return this.req<void>(this.cfg.authBase, `/auth/members/${userId}/sessions/${sessionId}`, {
      method: "DELETE",
    });
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
  /** `user_sessions` — login presence (device, active/idle time). */
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

  // ── channel moderation ──────────────────────────────────────────────────────
  /** Members WITH roles, plus anyone blocked. A separate route from
   *  `channelMembers()`, whose bare string[] the task dialog depends on.
   *
   *  The moderation sheet renders the whole roster with no "load more" — it's
   *  a full member-management view, not a feed — so this fetches every page
   *  itself rather than exposing limit/offset like `openChannels()` does.
   *  The server pages the members list and the blocked list INDEPENDENTLY
   *  under the same limit/offset pair (see ChannelRoster's doc comment), so a
   *  page can under-fill one side while still being full on the other; this
   *  only stops once BOTH sides come back short of a full page. */
  async channelRoster(channelId: string) {
    const pageSize = 200; // mirrors the server's clampChannelPage ceiling
    let offset = 0;
    const all: ChannelMemberDTO[] = [];
    for (;;) {
      const page = await this.req(
        this.cfg.messagingBase,
        `/api/v1/channels/${channelId}/members/roster?limit=${pageSize}&offset=${offset}`,
        {}, z.array(ChannelMemberDTO),
      );
      all.push(...page);
      const blockedCount = page.filter((m) => m.blocked).length;
      if (page.length - blockedCount < pageSize && blockedCount < pageSize) break;
      offset += pageSize;
    }
    return all;
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

  /** The org's tamper-evident audit trail, newest first. `before` is the
   *  `nextCursor` of the previous page. */
  auditLog(opts: { before?: string; limit?: number; action?: string; targetId?: string } = {}) {
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
  /** The locales auth-svc can currently translate the UI into — live from
   *  Google Cloud Translation (Redis-cached server-side), never a client-side
   *  hardcoded list. Empty when no Google credential is configured. */
  i18nLanguages() {
    return this.req(this.cfg.authBase, "/i18n/languages", {}, I18nLanguagesDTO);
  }
  /** The translated UI-string catalog for `locale`, one namespace bundle per
   *  key — see LanguageProvider, which is the only caller. Never sends the
   *  strings themselves; the server already holds the English source and
   *  translates from that on demand. */
  i18nCatalog(locale: string) {
    return this.req(this.cfg.authBase, `/i18n/catalog?locale=${encodeURIComponent(locale)}`, {}, I18nCatalogDTO);
  }
  /** These fields are independently optional. `themePrefs` is the whole
   *  account-wide theme document (preset, light/dark, Custom activation, and
   *  the palette) — see packages/app/src/lib/themeSync.tsx. `customTheme` is
   *  a legacy colours-only path some older clients may still send; both merge
   *  into the same server-side document. */
  updateProfile(body: {
    displayName?: string;
    avatarUrl?: string;
    themePrefs?: ThemePrefsDTO;
    customTheme?: CustomThemeDTO | null;
    expectedThemeRevision?: number;
  }) {
    return this.req(this.cfg.authBase, "/auth/me", {
      method: "PATCH",
      body: JSON.stringify(body),
    }, UserDTO);
  }
  /** `refreshToken` mirrors /auth/refresh's own body-token support: desktop
   *  and mobile cannot rely on the refresh cookie travelling (it's read from
   *  OS-encrypted storage instead — see apps/desktop/src/main/session-token.ts),
   *  so without this the server had no credential to resolve WHICH session to
   *  revoke and logout only ever cleared the cookie. Omit on web, where the
   *  cookie is the only — and sufficient — credential. */
  logout(refreshToken?: string) {
    return this.req<void>(this.cfg.authBase, "/auth/logout", {
      method: "POST",
      // req() already sends content-type: application/json unconditionally.
      ...(refreshToken ? { body: JSON.stringify({ token: refreshToken }) } : {}),
    });
  }
  /** Organizations the signed-in identity belongs to (for the switcher). */
  myOrgs() {
    return this.req(this.cfg.authBase, "/auth/orgs/mine", {}, z.array(OrgMembershipDTO));
  }
  myOrgsPage(params: { search: string; offset: number; limit: number }) {
    const query = new URLSearchParams({
      search: params.search,
      offset: String(params.offset),
      limit: String(params.limit),
    });
    return this.req(this.cfg.authBase, `/auth/orgs/mine?${query}`, {}, OrgMembershipPageDTO);
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
  leaveOrg(
    orgId: string,
    stepUp?: { password: string; totpCode?: string; backupCode?: string },
  ) {
    return this.req<void>(this.cfg.authBase, `/auth/orgs/${orgId}/leave`, {
      method: "POST",
      ...(stepUp ? { body: JSON.stringify(stepUp) } : {}),
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
  /** Authenticated self-service password change — current password only, no
   *  second factor (the caller already holds a valid session). */
  changePassword(body: { currentPassword: string; newPassword: string }) {
    return this.req<void>(this.cfg.authBase, "/auth/password/change", {
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

  // ── MFA (TOTP) ────────────────────────────────────────────────────────────────
  /** Verify the second factor a pending login is waiting on. Exactly one of
   *  totpCode or backupCode should be set. On success this
   *  IS the session — nothing further to call. */
  mfaChallengeVerify(body: {
    pendingToken: string;
    totpCode?: string;
    backupCode?: string;
  }) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/challenge/verify",
      { method: "POST", body: JSON.stringify(body) },
      SessionDTO,
    );
  }
  /** Step-up re-auth (password + a still-valid second factor) to turn MFA off.
   *  Exactly one of totpCode/backupCode should be set. */
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
   *  new batch — the old codes stop working immediately. Exactly one of
   *  totpCode or backupCode should be set. */
  mfaRegenerateBackupCodes(body: {
    password: string;
    totpCode?: string;
    backupCode?: string;
  }) {
    return this.req(
      this.cfg.authBase,
      "/auth/mfa/totp/backup-codes/regenerate",
      { method: "POST", body: JSON.stringify(body) },
      MfaBackupCodesResult,
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
  /** Sidebar badge totals (conversations/channels/inbox-peers unread) in one
   *  call — the lightweight alternative to fetching all three full lists just
   *  to sum their unread fields. Same underlying counts as summing
   *  conversations()/channels()/inboxPeers() yourself, computed server-side.
   *  See docs/API-LAZY-LOADING-AUDIT.md D1/S3. */
  unreadCounts() {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/unread-counts",
      {},
      z.object({ conversations: z.number(), channels: z.number(), inboxPeers: z.number() }),
    );
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
   * Open-or-create the caller's Notes-to-Self conversation, without sending
   * anything — the same "navigate, don't fabricate a greeting" shape as
   * `openConversation`. Idempotent: every call (first use, another device,
   * a second tab) resolves to the SAME conversation id.
   */
  openSelfChat() {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/conversations/self",
      { method: "POST" },
      z.object({ conversationId: z.string() }),
    );
  }
  /**
   * The "Share to Notes to Self" action on a task card, and also what a
   * self-assigned task's "Chat" button routes its ENTIRE composer through
   * (see useOpenTaskDiscussion/DMView — sendTaskDiscussionMessage rejects
   * peerId === caller, so this is the self-chat equivalent). Opens the
   * caller's self-chat (if this is its first use) and appends `body` tagged
   * with `taskId`, so it renders as a task-reference card exactly like a
   * task-discussion message does (see ChatThread's `taskId` rendering).
   * `replyToId` quotes another message in the same self-chat, same as `reply`.
   */
  shareTaskToSelfChat(taskId: string, body: string, clientMsgId?: string, replyToId?: string) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/conversations/self/share-task",
      { method: "POST", body: JSON.stringify({ taskId, body, clientMsgId: clientMsgId ?? uuid(), replyToId }) },
      z.object({ conversationId: z.string(), threadId: z.string(), messageId: z.string(), seq: z.number() }),
    );
  }
  /**
   * Resolve (or create) a task's chat target without sending anything —
   * exactly `openConversation`'s own "navigate, don't fabricate a greeting"
   * shape, for the "Chat" button on a task card/sticky widget. Idempotent.
   */
  openTaskDiscussion(taskId: string, target: { peerId: string } | { channelId: string }) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/tasks/${taskId}/discussion`,
      { method: "POST", body: JSON.stringify(target) },
      TaskDiscussionDTO,
    );
  }
  /**
   * Every visible task's chat target + unread count, in one round trip — what
   * the sticky widget/task list badge with "Comments" / "Comments N".
   */
  taskDiscussions(taskIds: string[]) {
    if (taskIds.length === 0) return Promise.resolve([] as TaskDiscussionSummaryDTO[]);
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/tasks/discussions?taskIds=${taskIds.join(",")}`,
      {},
      z.array(TaskDiscussionSummaryDTO),
    );
  }
  /** Send through a task's "Chat" entry point — DM or channel, whichever
   *  `target` names. Creates the discussion (and, for a DM's first message,
   *  its thread) on first use. The returned message carries `taskId`, so a
   *  task-focused conversation's composer routes through this instead of
   *  `reply`/`sendChannelMessage` to keep its messages permanently tagged. */
  sendTaskDiscussionMessage(
    taskId: string,
    body: string,
    clientMsgId: string | undefined,
    target: { peerId: string } | { channelId: string },
    replyToId?: string,
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/tasks/${taskId}/discussion/messages`,
      {
        method: "POST",
        body: JSON.stringify({ ...target, body, clientMsgId: clientMsgId ?? uuid(), replyToId }),
      },
      z.object({ messageId: z.string(), seq: z.number() }),
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
  reply(
    conversationId: string,
    body: string,
    clientMsgId?: string,
    replyToId?: string,
    /**
     * Optional system kind (e.g. "attachment_opened"); absent means an
     * ordinary reply. Mirrors sendMessage's Kind — see its doc comment.
     */
    kind?: MessageKind,
    /** Required alongside kind "attachment_opened"/"attachment_downloaded". */
    attachmentId?: string,
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ body, clientMsgId: clientMsgId ?? uuid(), replyToId, kind, attachmentId }),
      },
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
    // Resolved ONCE: the header and the body's clientMsgId must be the same
    // value, or a retry's idempotency-key header would not match the id the
    // first attempt's row was actually keyed on.
    const clientMsgId = opts?.clientMsgId ?? uuid();
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/threads/${threadId}/reply`,
      {
        method: "POST",
        headers: { "idempotency-key": clientMsgId },
        body: JSON.stringify({
          body,
          parentMessageId: opts?.parentMessageId ?? null,
          clientMsgId,
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
    idempotencyKey?: string,
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/mail/drafts/${mailId}/send`,
      {
        method: "POST",
        // Send has no natural client-supplied id, so the idempotency key is
        // what stops a double-tap on a slow connection fanning out twice.
        // Caller-suppliable so a retry after a dropped connection reuses the
        // same key instead of minting a new one that looks like a second send.
        headers: { "idempotency-key": idempotencyKey ?? uuid() },
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
  /** Record that the caller initiated a download of one file on this mail. */
  recordMailAttachmentDownload(mailId: string, attachmentId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/mail/${mailId}/attachments/${attachmentId}/downloaded`,
      { method: "POST" },
    );
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
      logger.warn("upload response validation failed", { issueCount: parsed.error.issues.length });
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
  commitAttachment(id: string, idempotencyKey?: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/attachments/${id}/commit`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey ?? uuid() },
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
  ignoreThread(threadId: string, idempotencyKey?: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/threads/${threadId}/ignore`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey ?? uuid() },
    });
  }
  /**
   * "Delete for me" — hides one message from THIS user's view only. Either
   * party may do it, for any message; the other side is unaffected and never
   * learns of it.
   */
  hideMessage(messageId: string, idempotencyKey?: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}/hide`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey ?? uuid() },
    });
  }
  /**
   * "Delete for everyone" — tombstones the message for both parties. SENDER
   * ONLY (the server enforces it). The row survives as a tombstone: `seq`
   * orders the conversation and other tables reference the id, and a reader
   * seeing "this message was deleted" is more honest than a silent gap.
   */
  deleteMessageForAll(messageId: string, idempotencyKey?: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}`, {
      method: "DELETE",
      headers: { "idempotency-key": idempotencyKey ?? uuid() },
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
  hideChannelMessage(messageId: string, idempotencyKey?: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/channel-messages/${messageId}/hide`,
      { method: "POST", headers: { "idempotency-key": idempotencyKey ?? uuid() } },
    );
  }
  /**
   * "Delete for everyone" in a channel — a tombstone, like the DM version.
   *
   * Permitted to the AUTHOR or to anyone who moderates the channel (owner,
   * channel admin, org_admin). The server is the authority; the UI only decides
   * whether to offer the option.
   */
  deleteChannelMessageForAll(messageId: string, idempotencyKey?: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/channel-messages/${messageId}`,
      { method: "DELETE", headers: { "idempotency-key": idempotencyKey ?? uuid() } },
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
  dismissMessage(messageId: string, idempotencyKey?: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}/dismiss`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey ?? uuid() },
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
  ignoreInboxItem(kind: InboxItemKind, refId: string, idempotencyKey?: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/inbox/items/${kind}/${refId}/ignore`,
      { method: "POST", headers: { "idempotency-key": idempotencyKey ?? uuid() } },
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
  restoreMail(refId: string, idempotencyKey?: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/inbox/items/MAIL/${refId}/restore`,
      { method: "POST", headers: { "idempotency-key": idempotencyKey ?? uuid() } },
    );
  }

  // ── tasks ──────────────────────────────────────────────────────────────────────
  /** Every project the caller may access, walking the server's bounded pages. */
  async projects() {
    const limit = 100;
    const rows: ProjectDTO[] = [];
    for (let offset = 0; ; offset += limit) {
      const page = await this.req(
        this.cfg.taskBase,
        `/api/v1/projects?limit=${limit}&offset=${offset}`,
        {},
        z.array(ProjectDTO),
      );
      rows.push(...page);
      if (page.length < limit) return rows;
    }
  }
  projectDetail(projectId: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      {},
      ProjectDTO,
    );
  }
  /** Mark a project COMPLETED. Only its creator or an org_admin may call this
   *  (ProjectDTO.canComplete), and only once every task in it is COMPLETED —
   *  the server re-checks both regardless of what the client showed. */
  completeProject(projectId: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/projects/${encodeURIComponent(projectId)}/complete`,
      { method: "POST" },
      ProjectDTO,
    );
  }
  /** A miss is expected while the New Task form is being typed. */
  async projectByName(name: string): Promise<ProjectDTO | null> {
    const query = new URLSearchParams({ name });
    try {
      return await this.req(
        this.cfg.taskBase,
        `/api/v1/projects/by-name?${query.toString()}`,
        {},
        ProjectDTO,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  createTask(body: {
    /** The task's own identity — its heading everywhere it's shown. Distinct
     *  from `title` below, which (despite the name) is the PROJECT this task
     *  is filed under. */
    taskTitle: string;
    title: string;
    description: string;
    assigneeIds?: string[];
    /** Optional: allocate to channels, with or without `assigneeIds` — all of it
     *  ONE task. The server resolves each channel's current members, counts a
     *  person named here and also in a channel once, and keeps the channels
     *  attached to the task so future joiners are auto-added via the
     *  ChannelMemberJoined consumer. At least one of the two must be non-empty. */
    channelIds?: string[];
    /** The original single-channel form; equivalent to `channelIds: [id]`. */
    channelId?: string;
    allocation?: "NOW" | "SCHEDULED" | "RECURRING";
    scheduledFor?: string;
    recurrence?: {
      startAt: string;
      frequency: "DAILY" | "WEEKLY" | "MONTHLY";
      interval: number;
      weekdays?: number[];
      monthlyRule?: "DAY_OF_MONTH" | "WEEKDAY_PATTERN";
      monthlyDay?: number;
      monthlyOrdinal?: number;
      monthlyWeekday?: number;
      endCondition: "NO_END" | "AFTER_OCCURRENCES" | "ON_DATE";
      endAt?: string;
      occurrenceCount?: number;
      deadline?: DeadlineRule;
    };
    /** Absolute deadline for an immediate or one-off scheduled task. */
    deadlineAt?: string;
  }, idempotencyKey?: string) {
    return this.req(this.cfg.taskBase, "/api/v1/tasks", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey ?? uuid() },
      body: JSON.stringify(body),
    }, z.object({ taskId: z.string(), scheduleId: z.string().nullish() }));
  }
  /**
   * Every row of one of the caller's task lists, walking the server's pages.
   *
   * These endpoints cap a response at 100 rows (50 by default) and callers used to
   * read only the first, so anyone past that many open tasks silently lost the rest
   * — and the desktop sticky refresh treated a task missing from the first page as
   * no longer wanted and unpinned it. The pages are ordered totally (see
   * tasks_read.py), so walking them neither skips nor repeats a row.
   *
   * Bounded, like the server's own cap: TASK_LIST_MAX_PAGES pages, so a runaway
   * list cannot turn one refresh into an unbounded run of requests.
   */
  private async taskListAllPages(path: string): Promise<StickyTaskDTO[]> {
    const rows: StickyTaskDTO[] = [];
    for (let page = 0; page < TASK_LIST_MAX_PAGES; page++) {
      const batch = await this.req(
        this.cfg.taskBase,
        `${path}?limit=${TASK_LIST_PAGE_SIZE}&offset=${page * TASK_LIST_PAGE_SIZE}`,
        {},
        z.array(StickyTaskDTO),
      );
      rows.push(...batch);
      if (batch.length < TASK_LIST_PAGE_SIZE) break;
    }
    return rows;
  }
  taskInbox() {
    return this.taskListAllPages("/api/v1/tasks/inbox");
  }
  taskAssigned() {
    return this.taskListAllPages("/api/v1/tasks/assigned");
  }
  tasksSticky() {
    return this.taskListAllPages("/api/v1/tasks/sticky");
  }
  /**
   * Task ids sticky-svc says still have an open commitment for this user.
   *
   * The AUTHORITATIVE pinned set, and durable in a way the client-local one
   * never was: it survives a reinstall and is the same on every device. Returns
   * null when no stickyBase is configured, so callers can fall through to the
   * task-svc-only behaviour rather than treating "not deployed" as "no pins".
   */
  async stickyPins(): Promise<string[] | null> {
    if (!this.cfg.stickyBase) return null;
    const rows = await this.req(
      this.cfg.stickyBase,
      "/api/v1/sticky/pins",
      {},
      z.array(z.object({ taskId: z.string() })),
    );
    return rows.map((r) => r.taskId);
  }
  /**
   * The caller's open pins WITH the user's own choice on each: the ids the user
   * has PINNED and the ids they have explicitly UNPINNED. Authoritative server
   * state — what Web and Desktop both render from, so a pin made on one is the
   * pin on the other.
   *
   * Walks the pages (bounded like taskListAllPages) so a user past one page of
   * commitments does not silently lose the rest. Null when no stickyBase is
   * configured, so a caller can tell "not deployed" from "no pins".
   */
  async stickyPinStates(): Promise<{ pinned: string[]; unpinned: string[] } | null> {
    const base = this.cfg.stickyBase;
    if (!base) return null;
    const pinned: string[] = [];
    const unpinned: string[] = [];
    for (let page = 0; page < TASK_LIST_MAX_PAGES; page++) {
      const batch = await this.req(
        base,
        `/api/v1/sticky/pins?includeUnpinned=true&limit=${TASK_LIST_PAGE_SIZE}&offset=${page * TASK_LIST_PAGE_SIZE}`,
        {},
        z.array(z.object({ taskId: z.string(), pinState: StickyPinStateSchema.default("PINNED") })),
      );
      for (const r of batch) (r.pinState === "UNPINNED" ? unpinned : pinned).push(r.taskId);
      if (batch.length < TASK_LIST_PAGE_SIZE) break;
    }
    return { pinned, unpinned };
  }
  /**
   * Pin — or RE-pin — a task: the user's explicit choice, stored server-side and
   * pushed to all their devices. Idempotent (a target state, not a toggle), so a
   * retry cannot invert it. 409 when the task has already finished; 404 when it
   * is not assigned to the caller. Rejects when no stickyBase is configured —
   * there is deliberately no local fallback, since a pin only one device knows
   * about is the bug this exists to fix.
   */
  stickyPin(taskId: string) {
    return this.stickyPinWrite(taskId, "PUT");
  }
  /** Unpin a task. The commitment is untouched; `stickyPin` brings the note back. */
  stickyUnpin(taskId: string) {
    return this.stickyPinWrite(taskId, "DELETE");
  }
  private stickyPinWrite(taskId: string, method: "PUT" | "DELETE") {
    if (!this.cfg.stickyBase) return Promise.reject(new Error("sticky service is not configured"));
    return this.req(
      this.cfg.stickyBase,
      `/api/v1/sticky/pins/${encodeURIComponent(taskId)}`,
      { method },
      StickyPinStateResult,
    );
  }
  /**
   * Confirm a note actually reached this user's screen.
   *
   * This is what stops services/sticky-relay nudging forever: an open pin with
   * no delivery confirmation is the only thing it acts on. Fire-and-forget —
   * a failure here costs at most one redundant nudge, which is far cheaper
   * than letting it break the note that was just shown.
   */
  async stickyAckDelivery(taskId: string): Promise<void> {
    if (!this.cfg.stickyBase) return;
    await this.req(
      this.cfg.stickyBase,
      `/api/v1/sticky/pins/${encodeURIComponent(taskId)}/ack-delivery`,
      { method: "POST" },
      z.unknown(),
    );
  }
  // ── integrations (connected external accounts — Settings > Integrations) ──
  /** Every connection visible to the caller (their own, plus any org-wide
   *  ones) — never includes tokens. Empty array when integrationsBase is not
   *  configured, same "feature unavailable" posture as the sticky methods. */
  async listIntegrations(): Promise<IntegrationConnectionDTO[]> {
    if (!this.cfg.integrationsBase) return [];
    return this.req(
      this.cfg.integrationsBase,
      "/api/v1/integrations",
      {},
      z.array(IntegrationConnectionDTO),
    );
  }
  /** Start connecting a provider. For an OAuth provider (e.g. teams) this
   *  returns an authorizeUrl to redirect the browser to; the connection
   *  itself is created by the provider's callback, not by this call.
   *  `returnTo: "desktop"` asks the callback to hand back to the
   *  `taskboard://oauth` custom scheme instead of the web app route — see
   *  integrations-svc's routes/oauth.py for why there is no third option. */
  connectIntegration(provider: string, options?: { returnTo?: "desktop" }) {
    if (!this.cfg.integrationsBase) {
      return Promise.reject(new Error("integrations service is not configured"));
    }
    return this.req(
      this.cfg.integrationsBase,
      `/api/v1/integrations/${encodeURIComponent(provider)}/connect/start`,
      { method: "POST", body: JSON.stringify(options ?? {}) },
      ConnectIntegrationResultDTO,
    );
  }
  /** Disconnect — revokes the stored token (best-effort, at the provider too)
   *  and stops any sync worker from touching this connection again. */
  disconnectIntegration(connectionId: string) {
    if (!this.cfg.integrationsBase) {
      return Promise.reject(new Error("integrations service is not configured"));
    }
    return this.req<void>(
      this.cfg.integrationsBase,
      `/api/v1/integrations/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }

  /** Single task assigned to me at ANY status — used by the inbox detail view so
   *  a terminal (completed/ignored/left) task opened from the unified inbox
   *  resolves from the server instead of 404-ing on a cache miss. */
  taskDetail(taskId: string) {
    return this.req(this.cfg.taskBase, `/api/v1/tasks/${taskId}/detail`, {}, StickyTaskDTO);
  }
  /** Snapshot analytics for one task — status breakdown, per-assignee timeline,
   *  and the two completion metrics (see TaskAnalyticsDTO). Visible to the
   *  sender or any assignee, same parties taskDetail already exposes it to. */
  taskAnalytics(taskId: string) {
    return this.req(this.cfg.taskBase, `/api/v1/tasks/${taskId}/analytics`, {}, TaskAnalyticsDTO);
  }
  /** Snapshot analytics across every task attached to a channel. Visible to
   *  channel members only (enforced server-side via messaging-svc). */
  channelAnalytics(channelId: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/channels/${channelId}/analytics`,
      {},
      ChannelAnalyticsDTO,
    );
  }
  /** Snapshot analytics across every task in a project (tasks.projectId).
   *  Visible to anyone who is the sender or an assignee of at least one task
   *  (or schedule) in the project — the same rule projectDetail enforces.
   *  `tasks` (the per-task breakdown) is paginated; every other field covers
   *  the whole project. */
  projectAnalytics(projectId: string, opts: { limit?: number; offset?: number } = {}) {
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.offset !== undefined) query.set("offset", String(opts.offset));
    const qs = query.toString();
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/projects/${encodeURIComponent(projectId)}/analytics${qs ? `?${qs}` : ""}`,
      {},
      ProjectAnalyticsDTO,
    );
  }
  /** Workspace-wide rollup (KPI totals with trend + sparkline, per-project
   *  ranking, per-person workload, a day-bucketed activity series, and a
   *  day×status flow series) behind the Analytics page's overview dashboard.
   *  Open to every member; a non-admin is row-scoped server-side to tasks
   *  they are already a party to — org_admin sees the unrestricted, org-wide
   *  rollup. `from`/`to` are absolute dates computed by the client in the
   *  viewer's timezone, same rule as `rangeQuery()`. */
  workspaceAnalyticsOverview(opts: { from?: string; to?: string; projectId?: string } = {}) {
    const query = new URLSearchParams();
    if (opts.from) query.set("from", opts.from);
    if (opts.to) query.set("to", opts.to);
    if (opts.projectId) query.set("projectId", opts.projectId);
    const qs = query.toString();
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/analytics/overview${qs ? `?${qs}` : ""}`,
      {},
      WorkspaceOverviewDTO,
    );
  }
  /** Reopen the completed assignments for this task; the server chooses recipients. */
  reassignTask(taskId: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/${taskId}/reassign`,
      { method: "POST" },
      z.object({
        taskId: z.string(),
        reassignedUserIds: z.array(z.string()),
        projectChannelSyncFailed: z.boolean().optional(),
      }),
    );
  }
  /** Tasks I sent, newest first. The server pages by task (default 50, max 100);
   *  pass `limit`/`offset` to walk further back. A task whose assignee ignored it
   *  is hidden from the sender unless `includeIgnored` is set. */
  tasksSent(opts?: { limit?: number; offset?: number; includeIgnored?: boolean }) {
    const q = new URLSearchParams();
    if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) q.set("offset", String(opts.offset));
    if (opts?.includeIgnored) q.set("includeIgnored", "true");
    const qs = q.toString();
    return this.req(this.cfg.taskBase, `/api/v1/tasks/sent${qs ? `?${qs}` : ""}`, {}, z.array(SentTaskDTO));
  }
  taskSchedules() {
    return this.req(
      this.cfg.taskBase,
      "/api/v1/tasks/schedules",
      {},
      z.array(ScheduledTaskDTO),
    );
  }
  cancelTaskSchedule(scheduleId: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/schedules/${encodeURIComponent(scheduleId)}`,
      { method: "DELETE" },
      z.object({ scheduleId: z.string(), status: z.literal("CANCELLED") }),
    );
  }
  updateTaskSchedule(scheduleId: string, nextRunAt: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/schedules/${encodeURIComponent(scheduleId)}`,
      { method: "PATCH", body: JSON.stringify({ nextRunAt }) },
      z.object({ scheduleId: z.string(), status: z.literal("UPDATED") }),
    );
  }
  taskAction(
    taskId: string,
    action: "acknowledge" | "complete" | "ignore" | "leave",
    idempotencyKey?: string,
  ) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/${taskId}/assignees/me/${action}`,
      { method: "POST", headers: { "idempotency-key": idempotencyKey ?? uuid() } },
      z.object({ status: z.string(), statusVersion: z.number() }),
    );
  }
  /** Add people and/or channels to an existing task. A channel's current members
   *  join it and the channel stays attached, so a later joiner is added too —
   *  the same two target kinds `createTask` takes. */
  addTaskParticipants(
    taskId: string,
    targets: { userIds?: string[]; channelIds?: string[] },
    idempotencyKey?: string,
  ) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/${taskId}/assignees`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey ?? uuid() },
        body: JSON.stringify({ userIds: targets.userIds ?? [], channelIds: targets.channelIds ?? [] }),
      },
      z.object({
        addedUserIds: z.array(z.string()),
        addedChannelIds: z.array(z.string()).default([]),
        projectChannelSyncFailed: z.boolean().optional(),
      }),
    );
  }
  withdrawTaskParticipant(taskId: string, userId: string, idempotencyKey?: string) {
    return this.req(
      this.cfg.taskBase,
      `/api/v1/tasks/${taskId}/assignees/${userId}`,
      { method: "DELETE", headers: { "idempotency-key": idempotencyKey ?? uuid() } },
      z.object({ withdrawnUserId: z.string(), statusVersion: z.number() }),
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
  /**
   * One page of the channels the caller is a member of, optionally narrowed by a
   * name search — the picker's read (`channels()` stays the sidebar's whole list).
   * Ordered by name, so offset paging is stable; a page shorter than `limit` is the
   * end. Lean rows: no last-message preview or unread count.
   *
   * Against a messaging-svc that predates `/channels/mine` (404/405) this falls back
   * to the whole list, filtered and sliced here, so a client deployed first keeps
   * working — at the cost the endpoint exists to avoid, until the server catches up.
   */
  async channelsPage(opts: { q?: string; limit?: number; offset?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.q?.trim()) q.set("q", opts.q.trim());
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    try {
      return await this.req(
        this.cfg.messagingBase,
        `/api/v1/channels/mine${qs ? `?${qs}` : ""}`,
        {},
        z.array(ChannelDTO),
      );
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
      const needle = (opts.q ?? "").trim().toLowerCase();
      const all = (await this.channels())
        .filter((c) => !needle || c.name.toLowerCase().includes(needle))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
      const from = opts.offset ?? 0;
      return all.slice(from, opts.limit != null ? from + opts.limit : undefined);
    }
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
  sendChannelMessage(
    channelId: string,
    body: string,
    clientMsgId?: string,
    kind?: MessageKind,
    replyToId?: string,
    /** Required alongside kind "attachment_opened"/"attachment_downloaded". */
    attachmentId?: string,
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ body, clientMsgId: clientMsgId ?? uuid(), kind, replyToId, attachmentId }),
      },
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
  /** `read` filters on the server (true = only read, false = only unread), so a
   *  page is a page of the rows asked for; omit it for both. */
  notificationPage(cursor?: string, limit = 10, read?: boolean) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    if (read !== undefined) q.set("read", String(read));
    return this.req(
      this.cfg.notificationBase,
      `/api/v1/notifications?${q.toString()}`,
      {},
      NotificationPageDTO,
    );
  }
  /** The notification bell's badge count — every unread notification, not
   *  just the (up to 200) most recent ones handleList/notifications() caps
   *  at, so this is actually MORE accurate than summing that list's !read
   *  rows for a caller with a deep backlog. See
   *  docs/API-LAZY-LOADING-AUDIT.md D1/S3.
   *
   *  tasksUnreadCount is the TASK_* subset of unreadCount — the Tasks rail
   *  badge. Everything else (channel/DM messages, meetings, calls) must only
   *  move unreadCount (the bell), never this field. */
  notificationsUnreadCount() {
    return this.req(
      this.cfg.notificationBase,
      "/api/v1/notifications/unread-count",
      {},
      z.object({ unreadCount: z.number(), tasksUnreadCount: z.number() }),
    );
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
  /** Mark unread notifications belonging to the supplied tasks as read. */
  markTaskNotificationsRead(taskIds: string[]) {
    return this.req(
      this.cfg.notificationBase,
      "/api/v1/notifications/read-by-tasks",
      { method: "POST", body: JSON.stringify({ taskIds }) },
      z.object({ updated: z.number().int().nonnegative() }),
    );
  }
  /** Mark unread notifications for exactly one conversation, channel, or call as read. */
  markNotificationsReadByTarget(target: NotificationReadTarget) {
    return this.req(
      this.cfg.notificationBase,
      "/api/v1/notifications/read-by-target",
      { method: "POST", body: JSON.stringify(target) },
      z.object({ updated: z.number().int().nonnegative() }),
    );
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
    /** Channels whose members are invited. The caller must be in each. */
    channelIds?: string[];
    /** Makes this the first of a repeating series; needs `scheduledAt`. The
     *  response is then the FIRST occurrence, carrying `series`. */
    recurrence?: MeetingRecurrenceInput;
  }) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/meetings",
      { method: "POST", body: JSON.stringify(body) },
      CallDTO,
    );
  }

  /** A repeating meeting's series — organiser only. What an edit form restores. */
  meetingSeries(seriesId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/meeting-series/${seriesId}`,
      {},
      MeetingSeriesDTO,
    );
  }

  /** Change a series. A field left out is left alone. Its UPCOMING occurrences are
   *  reconciled with the new shape: one whose date and time is still in the
   *  schedule keeps its id (so its join link and any guest who arrived by it), only
   *  dates that left the schedule are removed and only new ones are written, and
   *  people are added or removed as picked. Occurrences that have started or ended
   *  are never touched. */
  updateMeetingSeries(
    seriesId: string,
    body: {
      title?: string;
      inviteeIds?: string[];
      channelIds?: string[];
      recurrence?: MeetingRecurrenceInput;
    },
  ) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/meeting-series/${seriesId}`,
      { method: "PATCH", body: JSON.stringify(body) },
      MeetingSeriesDTO,
    );
  }

  /** Stop a series and remove its upcoming occurrences. Ones that have already
   *  started or ended stay as history. Cancelling twice is not an error. */
  cancelMeetingSeries(seriesId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/meeting-series/${seriesId}`, {
      method: "DELETE",
    });
  }

  /** Every call the caller is expected at, including meetings hosted by
   *  another organisation. */
  myCalls() {
    return this.req(this.cfg.messagingBase, "/api/v1/calls", {}, z.array(CallDTO));
  }

  /** Any call the caller is RIGHT NOW being rung for — an open, unexpired
   *  invitation on a LIVE call. Called once per fresh WS connection to
   *  recover a ring that started, or is still open, while the client was
   *  offline (the gateway's event replay deliberately does not re-announce
   *  a ring — see queryBridge's own reconnect handling). */
  myRingingCalls() {
    return this.req(this.cfg.messagingBase, "/api/v1/calls/ringing", {}, z.array(CallDTO));
  }

  call(callId: string) {
    return this.req(this.cfg.messagingBase, `/api/v1/calls/${callId}`, {}, CallDTO);
  }

  /** Every call the caller is on the roster of that OVERLAPS [from, to) —
   *  the calendar read, oldest first.
   *
   *  Deliberately neither of the two above. `myCalls()` caps finished calls at
   *  a month, so a calendar navigated back past one renders an empty week that
   *  is not empty; `myCallHistory()` has no day cap but runs newest-first
   *  behind a cursor and excludes SCHEDULED and LIVE entirely, so reaching an
   *  arbitrary week means paging everything in between. A window is bounded by
   *  itself, so this has no cursor.
   *
   *  Overlap rather than containment: a meeting that runs past midnight belongs
   *  to both days. Half-open, so one starting exactly at `to` belongs to the
   *  next window and is not drawn twice. Both bounds are ISO instants — send
   *  the LOCAL boundaries of the grid being drawn, since only the client knows
   *  where the viewer is. The server refuses a window wider than a quarter. */
  myCallsInRange(fromISO: string, toISO: string) {
    const q = new URLSearchParams({ from: fromISO, to: toISO });
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/range?${q.toString()}`,
      {},
      z.array(CallDTO),
    );
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

  /** The multi-select "Call": ONE ad-hoc call to all of these people (two or more),
   *  every one of them rung. The server applies the same rules as adding people to
   *  a call — your org, no blocks, MAX_ADHOC_CALL_PARTICIPANTS — and answers 403 /
   *  409 for a roster it refuses. Not a Meeting: it is never listed under Meetings. */
  startConferenceCall(peerIds: string[], media: "audio" | "video" = "video") {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/calls/direct",
      { method: "POST", body: JSON.stringify({ peerIds, media }) },
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
  *  JOIN is the ordinary entry, SWITCH is an explicit takeover, and REFRESH
  *  renews the current room's credentials without claiming another session.
  *  The separate checkCallReady() is for access/readiness probes that must
  *  not mint a token or reserve the participant slot.
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
  callToken(callId: string, mode: "JOIN" | "SWITCH" | "REFRESH" = "JOIN") {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/token`,
      { method: "POST", body: JSON.stringify({ mode }) },
      CallJoinDTO,
    );
  }

  /** Check call authorization and server readiness without minting a token or
   *  reserving the participant's active session. */
  checkCallReady(callId: string) {
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/calls/${callId}/token`,
      { method: "POST", body: JSON.stringify({ mode: "CHECK" }) },
    );
  }

  /** Reports a client-observed reconnect, by a bounded reason — see
   *  messaging-svc's metrics/calls.go for why this cannot be derived
   *  server-side and for the full ReconnectReason* taxonomy this is scoped
   *  to. Fire-and-forget from the caller's point of view: a failed telemetry
   *  POST must never affect the call itself.
   *
   *  "media": a transient ICE/signal disruption LiveKit recovered from on its
   *  own (the Room `Reconnected` event). "token_refresh": the client's own
   *  scheduled disconnect()+connect() to renew its room token before it
   *  expires (useCallRoom.ts's scheduleRefresh) — deliberately NOT something
   *  LiveKit surfaces as `Reconnected`, which is why this needs its own
   *  reason rather than being folded into the same call. */
  callTelemetryReconnected(callId: string, reason: "media" | "token_refresh") {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/telemetry`, {
      method: "POST",
      body: JSON.stringify({ event: "reconnected", reason }),
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

  /** Explicitly decline a ring. Always 204, even for a ring that already
   *  expired or was never there — see the server's declineCall doc comment.
   *  Resolves the one invitation (and, if it was the call's only ring, ends
   *  the call) the same way the server's own ring-timeout sweep does; this
   *  is just the user-initiated path to that same outcome. */
  declineCall(callId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/calls/${callId}/decline`, {
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
          code: asErrorCode(err.code),
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
