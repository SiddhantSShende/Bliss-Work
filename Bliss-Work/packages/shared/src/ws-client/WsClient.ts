/**
 * Typed multiplexed WebSocket client used by BOTH the web app and the Electron
 * utilityProcess. Single connection; jittered exponential-backoff reconnect;
 * heartbeat ping/pong; per-event-type subscriptions; client-side dedup on
 * eventId; emits raw ServerEvents after zod validation.
 */
import { ServerEvent, ControlFrame, type ClientFrame } from "../types/events";
import { decodeJwtPayload } from "../lib/jwt";

/**
 * What the client knows about an event beyond the event itself.
 *
 * `replayed` is true for anything delivered in the connect-time catch-up burst
 * — i.e. it happened before this socket existed. Caches must still be patched
 * from it; anything that ANNOUNCES (a toast, a re-pinned desktop note, a sound)
 * must not fire, or every launch replays the last 200 events at the user.
 */
export interface WsEventMeta {
  replayed: boolean;
}

type Handler = (e: ServerEvent, meta: WsEventMeta) => void;
type StatusHandler = (s: WsStatus) => void;
type ControlHandler = (f: ControlFrame) => void;
export type WsStatus = "connecting" | "open" | "closed" | "reauth";

export interface WsClientOptions {
  url: string;
  /** Returns a fresh access token (used on connect + on token.refresh.required). */
  getToken: () => string | Promise<string>;
  /** Called when the server asks for a fresh token; should refresh + return it. */
  refreshToken?: () => Promise<string>;
  /** True once the session is over for good (the rotating-refresh family was
   *  revoked, or it expired). Retrying cannot bring it back, so the client parks
   *  instead of reconnecting. Omit where no terminal signal exists. */
  isDead?: () => boolean;
  lastSeenSeq?: () => number | undefined;
  /** Injected for non-browser (Electron utilityProcess) environments. */
  WebSocketImpl?: typeof WebSocket;
}

const PING_INTERVAL_MS = 20_000;
/** How long to wait for a pong after sending a ping before treating the
 *  connection as a zombie. A socket can sit at readyState OPEN with no bytes
 *  actually flowing — a dead NAT/proxy path, a silent network partition — and
 *  without this the heartbeat is send-only: pings go out forever and nothing
 *  ever notices the replies stopped. Mirrors ws-gateway's own pingTimeout
 *  (10s — see services/ws-gateway/internal/server/conn.go) so the client
 *  notices a stall on roughly the same timescale the server would. */
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const DEDUP_LRU = 2048;
/** How long to wait for `onopen` before giving up on this attempt. A refused
 *  connection fires `onerror`/`onclose` promptly on its own; this exists for the
 *  case a handshake just HANGS (a proxy/firewall swallowing the WS upgrade, a
 *  dead-but-not-reset network path) rather than being actively rejected — with
 *  no timeout, the socket sits in CONNECTING forever, `scheduleReconnect()` is
 *  never reached (only `onclose` calls it), and `connect()`'s own idempotency
 *  guard (readyState 0 or 1 → no-op, see below) then makes every later
 *  token-forward a silent no-op too. Generous by design — bound the failure,
 *  don't time the happy path — same reasoning as REPLAY_GRACE_MS. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long to wait for `replay.done` before assuming it isn't coming. The
 *  catch-up burst is written in one pass immediately after `hello`, so this is
 *  generous by an order of magnitude — it exists to bound the failure, not to
 *  time the happy path. */
const REPLAY_GRACE_MS = 10_000;
// Phase 5: per-thread (or per-conversation when no thread is set) ack batching
// window. 500 ms keeps "Delivered" feeling instant to the sender while
// preventing a 1-msg-per-second-per-recipient HTTP storm to messaging-svc
// when a recipient catches up on a busy thread.
const ACK_FLUSH_MS = 500;
const ACK_MAX_BATCH = 32;

export class WsClient {
  private ws?: WebSocket;
  private readonly handlers = new Set<Handler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly controlHandlers = new Set<ControlHandler>();
  private readonly seen = new Set<string>();
  private seenOrder: string[] = [];
  private attempt = 0;
  private pingTimer?: ReturnType<typeof setInterval>;
  /** Dead-man's switch armed on every ping, cleared on the matching pong — see
   *  PONG_TIMEOUT_MS. */
  private pongTimer?: ReturnType<typeof setTimeout>;
  /** Handle for the pending backoff timer armed by scheduleReconnect(), so
   *  close() can cancel it — see hasLiveSocket()'s comment for why a lost
   *  handle is dangerous even with that cancellation in place. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  /** ackBuf: bucketed by (threadId ?? conversationId) so a single composer
   *  catching up on a backlog flushes one frame per bucket per ACK_FLUSH_MS. */
  private readonly ackBuf = new Map<string, Set<string>>();
  private ackFlushTimer?: ReturnType<typeof setTimeout>;
  /**
   * True from the moment `hello` is sent until the gateway's `replay.done`.
   * Everything delivered in that window is catch-up, not news.
   */
  private replaying = false;
  /**
   * Dead-man's switch on the above. `replay.done` is a newer frame than some
   * gateways send, and a lost marker would otherwise leave this client silently
   * suppressing every toast for the life of the connection — a far worse
   * failure than the storm it was added to prevent. The burst arrives inside
   * one connect round-trip, so anything still waiting after this is not coming.
   */
  private replayTimer?: ReturnType<typeof setTimeout>;
  /**
   * Highest `occurredAt` (epoch ms) seen on this client, which is the score the
   * gateway's replay ZSET is keyed by. Sent as the next `hello`'s cursor so a
   * reconnect within a session asks only for what it missed instead of pulling
   * the same 200 events again. Deliberately in memory: it is an optimisation,
   * and a fresh process legitimately wants the full catch-up.
   */
  private highWaterMs = 0;

  constructor(private readonly opts: WsClientOptions) {}

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Subscribe to inbound CONTROL frames — the rtc.* WebRTC signaling channel
   *  (rtc.offer/answer/ice/cancel + peer.unreachable/rate_limited). These never
   *  pass through the ServerEvent dedup/outbox path. Returns an unsubscribe fn. */
  onControl(handler: ControlHandler): () => void {
    this.controlHandlers.add(handler);
    return () => this.controlHandlers.delete(handler);
  }

  /** Send a client frame (rtc.* signaling). Best-effort: dropped if not open. */
  sendFrame(frame: ClientFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      /* socket not ready; caller may retry on reconnect */
    }
  }

  /** Subscribe to a single event type; returns an unsubscribe fn. */
  subscribe(
    type: ServerEvent["type"],
    handler: (e: ServerEvent, meta: WsEventMeta) => void,
  ): () => void {
    const wrapped: Handler = (e, meta) => {
      if (e.type === type) handler(e, meta);
    };
    return this.on(wrapped);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    // Idempotent: if a socket is already OPEN or CONNECTING, don't spin up a
    // second one. The Electron ws-process forwards the access token on EVERY
    // session change (login, silent refresh, focus) and each forward calls
    // connect() — without this guard that orphans the live socket and creates a
    // new one each time, churning the connection until event delivery stalls
    // (the "messages stop arriving live until I restart" bug). A genuine
    // reconnect still runs via onclose → scheduleReconnect → open(), which picks
    // up the freshest token. readyState: 0=CONNECTING, 1=OPEN.
    if (this.hasLiveSocket()) return;
    await this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.replayTimer) clearTimeout(this.replayTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Best-effort drain: ack any buffered messageIds before the socket goes.
    this.flushAcks();
    this.ws?.close();
  }

  /** readyState: 0=CONNECTING, 1=OPEN — see connect()'s comment for why a
   *  second socket in either state must never be dialed on top of it. Shared
   *  by connect() and the reconnect timer (scheduleReconnect) so both paths
   *  that can call open() agree on the same idempotency check. */
  private hasLiveSocket(): boolean {
    const rs = this.ws?.readyState;
    return rs === 0 || rs === 1;
  }

  private setStatus(s: WsStatus) {
    for (const h of this.statusHandlers) h(s);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    // A terminal session cannot be revived by dialing again: the gateway will
    // reject every handshake, so park rather than reconnect. Without this the
    // onclose → scheduleReconnect → open() cycle re-dials at the capped backoff
    // FOREVER with an empty token — 91 `?token=` rejections in 15 minutes on
    // prod, all logged by ws-gateway as "empty token". Both hosts re-enter
    // through connect() once a session exists again (web: the orgId-keyed effect
    // in queryBridge; Electron: the ws-process "token" message), and a fresh
    // login clears the flag, so parking here is not a dead end.
    if (this.opts.isDead?.()) {
      this.setStatus("closed");
      return;
    }
    this.setStatus("connecting");
    let token = await this.opts.getToken();
    // A close() can land while the getToken() await above was in flight (e.g.
    // queryBridge's orgId-keyed effect calling close() then connect() again on
    // an orgId change — see packages/app/src/lib/queryBridge.tsx). Without this
    // check, this now-orphaned open() call would fall straight through to
    // constructing and assigning a socket that close() already told to stop —
    // nothing could ever close it again. No WebSocket has been constructed yet
    // at this point, so returning here is enough; no teardown needed.
    if (this.stopped) return;
    // The gateway authenticates the token at the WS HANDSHAKE and rejects an
    // expired one (401). The access token lives ~15 min; an already-open socket
    // survives expiry, but a RECONNECT after expiry (sleep/network blip/app
    // restart) would reuse the stale token and loop the handshake forever —
    // realtime messaging silently dies. So refresh up-front whenever the token
    // is missing or (near-)expired. refreshToken is single-flight in the caller,
    // so this can't double-spend the rotating refresh token.
    if (this.opts.refreshToken && isExpiredJwt(token)) {
      this.setStatus("reauth");
      try {
        const fresh = await this.opts.refreshToken();
        if (fresh) token = fresh;
      } catch {
        // Refresh failed (e.g. dead refresh cookie) — attempt with what we have;
        // the rejected handshake reschedules a reconnect.
      }
      if (this.stopped) return;
    }
    // The refresh above is what LEARNS the session is terminal (it reads the
    // 'reused'/'expired'/'deactivated' code off the 401), so re-check after it
    // rather than only on entry.
    if (this.opts.isDead?.()) {
      this.setStatus("closed");
      return;
    }
    // An empty token can never pass the handshake, so don't spend one on it.
    // This is the non-terminal case — the session just isn't loaded yet — so a
    // reconnect is still scheduled, but it costs a timer instead of a rejected
    // connection to the gateway.
    if (!token) {
      this.setStatus("closed");
      this.scheduleReconnect();
      return;
    }
    const Impl = this.opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    const url = `${this.opts.url}?token=${encodeURIComponent(token)}`;
    const ws = new Impl(url);
    this.ws = ws;

    // See CONNECT_TIMEOUT_MS: force a still-CONNECTING socket closed so the
    // ordinary onclose -> scheduleReconnect() path takes over, exactly as it
    // already does for an actively-refused connection.
    const connectTimer = setTimeout(() => {
      if (ws.readyState === 0) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      this.attempt = 0;
      this.setStatus("open");
      // Prefer our own high-water mark over the host's initial hint: within a
      // session it is always the more advanced of the two.
      const lastSeenSeq = this.highWaterMs || this.opts.lastSeenSeq?.();
      this.startReplay();
      ws.send(JSON.stringify({ type: "hello", lastSeenSeq }));
      this.startPing();
    };

    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);

    ws.onclose = () => {
      clearTimeout(connectTimer);
      // A socket close()/connect() already replaced (an org switch) finishes
      // closing LATER. Acting on it would report "closed" while the new socket is
      // up, stop that socket's heartbeat, and queue a reconnect.
      if (this.ws !== ws) return;
      this.setStatus("closed");
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; reconnect handled there.
    };
  }

  /** Enter catch-up mode, armed with the dead-man's switch. */
  private startReplay() {
    this.replaying = true;
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(() => this.endReplay(), REPLAY_GRACE_MS);
  }

  private endReplay() {
    this.replaying = false;
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
        this.armPongTimeout();
      } catch {
        /* ignore */
      }
    }, PING_INTERVAL_MS);
  }

  /** Arms the zombie-connection dead-man's switch for one ping. If no pong
   *  clears it within PONG_TIMEOUT_MS, the socket is forced closed — the
   *  ordinary onclose -> scheduleReconnect() path then recovers it exactly as
   *  it would for any other disconnect. */
  private armPongTimeout() {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.ws?.close();
    }, PONG_TIMEOUT_MS);
  }

  private async handleMessage(raw: unknown) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }

    // The heartbeat reply. Handled ahead of the typed unions below because
    // "pong" — like the "ping" this answers — is a raw wire-level frame, not
    // part of the ClientFrame/ControlFrame/ServerEvent contract.
    if ((parsed as { type?: unknown } | null)?.type === "pong") {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
      }
      return;
    }

    // Control frames first.
    const control = ControlFrame.safeParse(parsed);
    if (control.success) {
      if (control.data.type === "token.refresh.required" && this.opts.refreshToken) {
        this.setStatus("reauth");
        try {
          const token = await this.opts.refreshToken();
          this.ws?.send(JSON.stringify({ type: "auth.renew", token }));
        } catch {
          // Refresh failed (e.g. dead refresh cookie) — same as open()'s
          // identical call. Unlike there, this socket is already open with no
          // handshake left to reject it, so nothing else would ever move us
          // out of "reauth": force it closed and let the ordinary
          // onclose -> scheduleReconnect() -> open() path recover it, the
          // same backstop armPongTimeout uses for a zombie connection.
          this.ws?.close();
        }
      }
      // Catch-up is over; everything from here is genuinely new.
      if (control.data.type === "replay.done") this.endReplay();
      // Fan out rtc.* signaling (and other control frames) to the WebRTC layer.
      for (const h of this.controlHandlers) h(control.data);
      return;
    }

    const result = ServerEvent.safeParse(parsed);
    if (!result.success) {
      // Neither a control frame nor a valid ServerEvent. This should not happen
      // in production — if it does, a producer/contract drift is silently eating
      // a live update, so surface it loudly instead of dropping in silence.
      console.warn("[ws] dropped unrecognized frame", parsed, result.error?.issues);
      return;
    }
    const e = result.data;

    // Dedup on eventId.
    if (this.seen.has(e.eventId)) return;
    this.seen.add(e.eventId);
    this.seenOrder.push(e.eventId);
    if (this.seenOrder.length > DEDUP_LRU) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }

    // Phase 5: queue a delivery ack for MessageCreated events not authored by
    // me. Only message.created ever reaches this branch, so delivered/read/
    // dismissed events can never echo back through this path.
    if (e.type === "message.created") {
      this.queueAck(e.threadId ?? e.conversationId, e.messageId);
    }

    // Advance the replay cursor. The gateway scores its outbox by occurredAt in
    // epoch-ms, so this is exactly the value its `lastSeenSeq` compares against.
    const at = Date.parse(e.occurredAt);
    if (Number.isFinite(at) && at > this.highWaterMs) this.highWaterMs = at;

    const meta: WsEventMeta = { replayed: this.replaying };
    for (const h of this.handlers) h(e, meta);
  }

  /** Bucket a messageId for a 500ms-deferred batched ack frame. */
  private queueAck(bucket: string, messageId: string) {
    let s = this.ackBuf.get(bucket);
    if (!s) {
      s = new Set();
      this.ackBuf.set(bucket, s);
    }
    s.add(messageId);
    // Drain proactively if a single bucket grows past the gateway cap.
    if (s.size >= ACK_MAX_BATCH) {
      this.flushAcks();
      return;
    }
    if (!this.ackFlushTimer) {
      this.ackFlushTimer = setTimeout(() => this.flushAcks(), ACK_FLUSH_MS);
    }
  }

  private flushAcks() {
    if (this.ackFlushTimer) {
      clearTimeout(this.ackFlushTimer);
      this.ackFlushTimer = undefined;
    }
    if (!this.ws || this.ackBuf.size === 0) return;
    for (const [, ids] of this.ackBuf) {
      if (ids.size === 0) continue;
      try {
        this.ws.send(JSON.stringify({ type: "message.ack", messageIds: [...ids] }));
      } catch {
        // best-effort; next message.created will rebuild the batch
      }
    }
    this.ackBuf.clear();
  }

  private scheduleReconnect() {
    // `stopped` covers a deliberate close(); isDead covers a session the server
    // has terminated. Both mean "do not re-arm the timer" — open() also checks,
    // but stopping here keeps a dead client from holding a pending timeout.
    if (this.stopped || this.opts.isDead?.()) return;
    this.attempt += 1;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const jitter = Math.random() * base * 0.3;
    // Clear rather than leak: a timer already pending here (shouldn't happen
    // in practice — see class field comment) would otherwise dodge close()'s
    // cancellation entirely.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // A close()/connect() cycle (sign-out/sign-in on the same long-lived
      // client, or any other direct connect() call) may already have dialed a
      // fresh socket while this timer sat waiting — close() cancels a timer it
      // knows about, but calling open() unconditionally here would still race
      // a connect() that ran without going through close() first. Guard the
      // same way connect() does so a stale timer can never orphan a live
      // socket with a second one.
      if (this.hasLiveSocket()) return;
      void this.open();
    }, base + jitter);
  }
}

/**
 * Best-effort check that a JWT is missing or within `skewSec` of expiry, so the
 * WS can refresh BEFORE the gateway rejects it at the handshake. A token we
 * can't parse (not a JWT / no exp) is treated as NOT-expired — let the server be
 * the authority — but an absent token forces a refresh.
 */
function isExpiredJwt(token: string | undefined, skewSec = 15): boolean {
  if (!token) return true;
  const claims = decodeJwtPayload<{ exp?: number }>(token);
  if (!claims || typeof claims.exp !== "number") return false;
  return claims.exp * 1000 <= Date.now() + skewSec * 1000;
}
