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
  AgentTokenDTO,
  ActivitySummaryDTO,
  AuditPage,
  AvailabilityDTO,
  ChannelDTO,
  ChannelMemberDTO,
  type ChannelRole,
  ChannelMessageDTO,
  AppCredentialDTO,
  ConnectStartDTO,
  ConversationDTO,
  ForwardActivityDTO,
  ForwardEdgeDTO,
  IntegrationConnectionDTO,
  MentionPageDTO,
  MentionState,
  ProviderActivityDTO,
  ProviderIdentityDTO,
  type Role,
  InboxPageDTO,
  InboxPeerDTO,
  InviteDTO,
  MemberActivityDTO,
  MemberDTO,
  MessageDTO,
  type MessageKind,
  NotificationDTO,
  OrgMembershipDTO,
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

export interface ApiConfig {
  authBase: string; // e.g. http://localhost:8001
  taskBase: string; // e.g. http://localhost:8002
  messagingBase: string; // e.g. http://localhost:8004
  integrationsBase: string; // external integrations svc, e.g. http://localhost:8005
  telemetryBase: string; // member activity record, e.g. http://localhost:8006
  notificationBase: string; // notifications are served by task/notification svc
  presenceBase: string; // ws-gateway HTTP, e.g. http://localhost:8090
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

  // ── auth / org / invite ─────────────────────────────────────────────────────
  createOrg(body: { orgName: string; email: string; password: string; displayName: string }) {
    return this.req(this.cfg.authBase, "/auth/orgs", {
      method: "POST",
      body: JSON.stringify(body),
    }, SessionDTO);
  }
  login(body: { email: string; password: string }) {
    return this.req(this.cfg.authBase, "/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }, SessionDTO);
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

  /** The org's tamper-evident audit trail, newest first. `before` is the
   *  `nextCursor` of the previous page. */
  // ── activity agents (desktop sampler / browser extension) ───────────────────
  /** Mint a pairing secret for one of YOUR OWN agents. The raw value is
   *  returned exactly once and never again — losing it means minting another,
   *  which is the correct cost for a credential that writes your activity. */
  createAgentToken(kind: "desktop" | "extension", label = "") {
    const q = new URLSearchParams({ kind });
    if (label) q.set("label", label);
    return this.req(this.cfg.telemetryBase, `/telemetry/tokens?${q.toString()}`, {
      method: "POST",
    }, z.object({ id: z.string(), kind: z.string(), token: z.string() }));
  }
  listAgentTokens() {
    return this.req(this.cfg.telemetryBase, "/telemetry/tokens", {}, z.array(AgentTokenDTO));
  }
  revokeAgentToken(id: string) {
    return this.req<void>(this.cfg.telemetryBase, `/telemetry/tokens/${id}`, {
      method: "DELETE",
    });
  }

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
  updateProfile(body: { displayName: string }) {
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
  /** Switch the active organization — returns a fresh session (new access token +
   *  org-scoped user) for the caller's membership in `orgId`. */
  switchOrg(orgId: string) {
    return this.req(
      this.cfg.authBase,
      `/auth/orgs/${orgId}/switch`,
      { method: "POST" },
      SessionDTO,
    );
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

  // ── messaging ─────────────────────────────────────────────────────────────────
  conversations() {
    return this.req(this.cfg.messagingBase, "/api/v1/conversations", {}, z.array(ConversationDTO));
  }
  messages(conversationId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/messages`,
      {},
      z.array(MessageDTO),
    );
  }
  /**
   * Send a top-level DM. clientMsgId can be supplied by the caller so the
   * Electron utility process (which serializes sends from sticky widgets)
   * can dedupe across windows; otherwise a fresh UUID is generated here.
   */
  sendMessage(recipientId: string, body: string, clientMsgId?: string, kind?: MessageKind) {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/conversations/messages",
      { method: "POST", body: JSON.stringify({ recipientId, body, clientMsgId: clientMsgId ?? uuid(), kind }) },
      z.object({
        conversationId: z.string(),
        threadId: z.string(),
        messageId: z.string(),
        seq: z.number(),
      }),
    );
  }
  reply(conversationId: string, body: string, clientMsgId?: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/conversations/${conversationId}/reply`,
      { method: "POST", body: JSON.stringify({ body, clientMsgId: clientMsgId ?? uuid() }) },
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
  /** Unified inbox feed: messages + tasks intermixed, newest first. When
   *  peerId is given, only items with that counterparty are returned. */
  inbox(cursor?: string, limit = 25, peerId?: string) {
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    qs.set("limit", String(limit));
    if (peerId) qs.set("peerId", peerId);
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/inbox?${qs.toString()}`,
      {},
      InboxPageDTO,
    );
  }
  /** Distinct counterparties in the caller's inbox (People sidebar). */
  inboxPeers() {
    return this.req(this.cfg.messagingBase, "/api/v1/inbox/peers", {}, z.array(InboxPeerDTO));
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
  replyToThread(threadId: string, body: string, opts?: { parentMessageId?: string; clientMsgId?: string }) {
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
        }),
      },
      z.object({ messageId: z.string(), seq: z.number() }),
    );
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

  /** Removes the thread from BOTH users' inbox; revives on next reply. */
  ignoreThread(threadId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/threads/${threadId}/ignore`, {
      method: "POST",
      headers: { "idempotency-key": uuid() },
    });
  }
  /** Sender-only soft-delete: hides this message from the sender's own inbox. */
  dismissMessage(messageId: string) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/messages/${messageId}/dismiss`, {
      method: "POST",
      headers: { "idempotency-key": uuid() },
    });
  }
  /** Forward a message to another Bliss-Work user. The recipient receives it as a
   *  normal message; the ORIGINAL author is notified live (message.forwarded) and
   *  can see it in the forwarding-activity tree. Idempotent on clientMsgId. */
  forwardMessage(messageId: string, recipientId: string, clientMsgId?: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/messages/${messageId}/forward`,
      { method: "POST", body: JSON.stringify({ recipientId, clientMsgId: clientMsgId ?? uuid() }) },
      z.object({
        conversationId: z.string(),
        threadId: z.string(),
        messageId: z.string(),
        seq: z.number(),
      }),
    );
  }
  /** Forward a message OUT to a contact on a connected external platform (Slack
   *  channel, WhatsApp number, …). Records the forward + notifies the original
   *  author, same as an in-app forward, with the platform tagged. */
  forwardMessageExternal(messageId: string, connectionId: string, target: string, clientMsgId?: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/messages/${messageId}/forward-external`,
      { method: "POST", body: JSON.stringify({ connectionId, target, clientMsgId: clientMsgId ?? uuid() }) },
      z.object({ status: z.string(), externalId: z.string().optional(), platform: z.string() }),
    );
  }
  /** The downstream forward tree of a message the caller authored — every hop,
   *  ordered by depth. Empty when the message was never forwarded. */
  messageForwards(messageId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/messages/${messageId}/forwards`,
      {},
      z.array(ForwardEdgeDTO),
    );
  }
  /** The caller's originals that have been forwarded, newest first — the
   *  "who forwarded my messages" feed for the Integrations section. */
  myForwardActivity() {
    return this.req(
      this.cfg.messagingBase,
      "/api/v1/forwards/activity",
      {},
      z.array(ForwardActivityDTO),
    );
  }

  // ── External Integrations (integrations-svc) ─────────────────────────────
  /** Connected external accounts for the caller/org. Never returns tokens. */
  integrations() {
    return this.req(
      this.cfg.integrationsBase,
      "/api/v1/integrations",
      {},
      z.array(IntegrationConnectionDTO),
    );
  }
  /** Start connecting a provider. Token-paste providers (Slack/WhatsApp) accept
   *  their credentials in `credentials` and return the created connection; OAuth
   *  providers (Gmail/Outlook/Teams) ignore it and return an authorizeUrl to
   *  redirect to. */
  connectIntegration(
    provider: string,
    credentials: Record<string, unknown> = {},
    returnTo?: "web" | "desktop",
  ) {
    // `returnTo` is a MODE, not a URL — the server maps it to one of two
    // known destinations so this can never become an open redirect. "desktop"
    // returns through the taskboard:// deep link because the consent screen
    // runs in the system browser there.
    return this.req(
      this.cfg.integrationsBase,
      `/api/v1/integrations/${provider}/connect/start`,
      { method: "POST", body: JSON.stringify({ ...credentials, returnTo }) },
      ConnectStartDTO,
    );
  }
  /** Disconnect + revoke a connection (purges its stored tokens). Idempotent. */
  disconnectIntegration(id: string) {
    return this.req<void>(this.cfg.integrationsBase, `/api/v1/integrations/${id}`, {
      method: "DELETE",
    });
  }
  /** Unified hub activity timeline (inbound + outbound), newest first.
   *  Audit/debug surface — the Hub UI renders `mentions()` instead. */
  integrationActivity() {
    return this.req(
      this.cfg.integrationsBase,
      "/api/v1/integrations/activity",
      {},
      z.array(ProviderActivityDTO),
    );
  }

  /** My @-mentions across connected accounts, newest first. Keyset-paginated —
   *  pass the previous page's `nextCursor` back verbatim. */
  mentions(state: MentionState = "pending", cursor?: string, limit = 25) {
    const q = new URLSearchParams({ state, limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.req(
      this.cfg.integrationsBase,
      `/api/v1/integrations/mentions?${q.toString()}`,
      {},
      MentionPageDTO,
    );
  }

  /** Turn a mention into a task assigned to me. Idempotent: a retry returns the
   *  SAME taskId (the server derives a deterministic key from the mention), so
   *  a double-click or a reconnect can never produce two tasks. 409 when the
   *  mention was already dismissed. */
  claimMention(activityId: string) {
    return this.req(
      this.cfg.integrationsBase,
      `/api/v1/integrations/mentions/${activityId}/claim`,
      { method: "POST", body: "{}" },
      z.object({ taskId: z.string().uuid(), state: MentionState }),
    );
  }

  /** Dismiss a mention permanently. Idempotent; 409 if already claimed. */
  ignoreMention(activityId: string) {
    return this.req(
      this.cfg.integrationsBase,
      `/api/v1/integrations/mentions/${activityId}/ignore`,
      { method: "POST", body: "{}" },
      z.object({ state: MentionState }),
    );
  }

  /** My handles on each platform — what mention matching resolves against. */
  providerIdentities() {
    return this.req(
      this.cfg.integrationsBase,
      "/api/v1/integrations/identities",
      {},
      z.array(ProviderIdentityDTO),
    );
  }

  /** Declare a handle. 409 when a teammate already owns it. */
  addProviderIdentity(provider: string, handle: string) {
    return this.req(
      this.cfg.integrationsBase,
      "/api/v1/integrations/identities",
      { method: "POST", body: JSON.stringify({ provider, handle }) },
      ProviderIdentityDTO,
    );
  }

  removeProviderIdentity(id: string) {
    return this.req<void>(
      this.cfg.integrationsBase,
      `/api/v1/integrations/identities/${id}`,
      { method: "DELETE" },
    );
  }

  /** This workspace's own OAuth apps, one entry per vendor. Includes the exact
   *  redirect URIs to register; never includes a client secret. */
  appCredentials() {
    return this.req(
      this.cfg.integrationsBase,
      "/api/v1/integrations/app-credentials",
      {},
      z.array(AppCredentialDTO),
    );
  }

  /** Save or rotate this workspace's OAuth app for a vendor.
   *  `tenant` is Microsoft-only; `pubsubTopic` is Google-only — the server
   *  rejects the wrong one rather than storing a value it will never read. */
  saveAppCredentials(
    vendor: "google" | "microsoft",
    creds: {
      clientId: string;
      clientSecret: string;
      tenant?: string;
      pubsubTopic?: string;
    },
  ) {
    return this.req(
      this.cfg.integrationsBase,
      `/api/v1/integrations/app-credentials/${vendor}`,
      { method: "PUT", body: JSON.stringify(creds) },
      AppCredentialDTO,
    );
  }

  removeAppCredentials(vendor: "google" | "microsoft") {
    return this.req<void>(
      this.cfg.integrationsBase,
      `/api/v1/integrations/app-credentials/${vendor}`,
      { method: "DELETE" },
    );
  }
  readThread(threadId: string, upToSeq: number) {
    return this.req<void>(this.cfg.messagingBase, `/api/v1/threads/${threadId}/read`, {
      method: "POST",
      body: JSON.stringify({ upToSeq }),
    });
  }
  /** Mark a unified-inbox row "seen" when it's opened. TASK rows have no seq
   *  model, so this is the only path that clears their unread badge (THREAD is
   *  routed server-side to the seq-based read). Idempotent + best-effort. */
  readInboxItem(kind: "TASK" | "THREAD", refId: string) {
    // Naturally idempotent (unread → 0); mirrors readThread which sends no key.
    return this.req<void>(
      this.cfg.messagingBase,
      `/api/v1/inbox/items/${kind}/${refId}/read`,
      { method: "POST" },
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
  /** Directory of OPEN channels the caller isn't already a member of. Used
   *  by the "Browse channels" view in the Channels sidebar. */
  openChannels() {
    return this.req(this.cfg.messagingBase, "/api/v1/channels/open", {}, z.array(ChannelDTO));
  }
  createChannel(body: { name: string; memberIds: string[]; isLocked?: boolean }) {
    return this.req(this.cfg.messagingBase, "/api/v1/channels", {
      method: "POST",
      body: JSON.stringify({ isLocked: false, ...body }),
    }, ChannelDTO);
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
  channelMessages(channelId: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/messages`,
      {},
      z.array(ChannelMessageDTO),
    );
  }
  sendChannelMessage(channelId: string, body: string, clientMsgId?: string) {
    return this.req(
      this.cfg.messagingBase,
      `/api/v1/channels/${channelId}/messages`,
      { method: "POST", body: JSON.stringify({ body, clientMsgId: clientMsgId ?? uuid() }) },
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
  presence() {
    return this.req(this.cfg.presenceBase, "/presence", {}, z.array(z.string()));
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
