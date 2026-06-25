/**
 * Typed multiplexed WebSocket client used by BOTH the web app and the Electron
 * utilityProcess. Single connection; jittered exponential-backoff reconnect;
 * heartbeat ping/pong; per-event-type subscriptions; client-side dedup on
 * eventId; emits raw ServerEvents after zod validation.
 */
import { ServerEvent, ControlFrame, type ClientFrame } from "../types/events";

type Handler = (e: ServerEvent) => void;
type StatusHandler = (s: WsStatus) => void;
type ControlHandler = (f: ControlFrame) => void;
export type WsStatus = "connecting" | "open" | "closed" | "reauth";

export interface WsClientOptions {
  url: string;
  /** Returns a fresh access token (used on connect + on token.refresh.required). */
  getToken: () => string | Promise<string>;
  /** Called when the server asks for a fresh token; should refresh + return it. */
  refreshToken?: () => Promise<string>;
  lastSeenSeq?: () => number | undefined;
  /** Injected for non-browser (Electron utilityProcess) environments. */
  WebSocketImpl?: typeof WebSocket;
}

const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const DEDUP_LRU = 2048;
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
  private stopped = false;
  /** ackBuf: bucketed by (threadId ?? conversationId) so a single composer
   *  catching up on a backlog flushes one frame per bucket per ACK_FLUSH_MS. */
  private readonly ackBuf = new Map<string, Set<string>>();
  private ackFlushTimer?: ReturnType<typeof setTimeout>;

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
  subscribe(type: ServerEvent["type"], handler: (e: ServerEvent) => void): () => void {
    const wrapped: Handler = (e) => {
      if (e.type === type) handler(e);
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
    const rs = this.ws?.readyState;
    if (rs === 0 || rs === 1) return;
    await this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    // Best-effort drain: ack any buffered messageIds before the socket goes.
    this.flushAcks();
    this.ws?.close();
  }

  private setStatus(s: WsStatus) {
    for (const h of this.statusHandlers) h(s);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    let token = await this.opts.getToken();
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
    const Impl = this.opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    const url = `${this.opts.url}?token=${encodeURIComponent(token)}`;
    const ws = new Impl(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      const lastSeenSeq = this.opts.lastSeenSeq?.();
      ws.send(JSON.stringify({ type: "hello", lastSeenSeq }));
      this.startPing();
    };

    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);

    ws.onclose = () => {
      this.setStatus("closed");
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; reconnect handled there.
    };
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore */
      }
    }, PING_INTERVAL_MS);
  }

  private async handleMessage(raw: unknown) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }

    // Control frames first.
    const control = ControlFrame.safeParse(parsed);
    if (control.success) {
      if (control.data.type === "token.refresh.required" && this.opts.refreshToken) {
        this.setStatus("reauth");
        const token = await this.opts.refreshToken();
        this.ws?.send(JSON.stringify({ type: "auth.renew", token }));
      }
      // Fan out rtc.* signaling (and other control frames) to the WebRTC layer.
      for (const h of this.controlHandlers) h(control.data);
      return;
    }

    const result = ServerEvent.safeParse(parsed);
    if (!result.success) return;
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
    // me. The loop guard (NO_DELIVERY_ACK_FOR mirrored on the gateway) means
    // delivered/read/dismissed events never echo back through this path.
    if (e.type === "message.created") {
      this.queueAck(e.threadId ?? e.conversationId, e.messageId);
    }

    for (const h of this.handlers) h(e);
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
    if (this.stopped) return;
    this.attempt += 1;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const jitter = Math.random() * base * 0.3;
    setTimeout(() => void this.open(), base + jitter);
  }
}

/** base64url JWT-payload decode that works in both the browser (atob) and the
 *  Electron utilityProcess / Node (Buffer). Returns "" if neither is available. */
function decodeBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  if (typeof atob === "function") return atob(b64 + pad);
  const B = (globalThis as { Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } } }).Buffer;
  if (B) return B.from(b64 + pad, "base64").toString("binary");
  return "";
}

/**
 * Best-effort check that a JWT is missing or within `skewSec` of expiry, so the
 * WS can refresh BEFORE the gateway rejects it at the handshake. A token we
 * can't parse (not a JWT / no exp) is treated as NOT-expired — let the server be
 * the authority — but an absent token forces a refresh.
 */
function isExpiredJwt(token: string | undefined, skewSec = 15): boolean {
  if (!token) return true;
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const json = JSON.parse(decodeBase64Url(payload));
    if (typeof json.exp !== "number") return false;
    return json.exp * 1000 <= Date.now() + skewSec * 1000;
  } catch {
    return false;
  }
}
