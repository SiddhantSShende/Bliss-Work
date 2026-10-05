/**
 * The buffer between "something happened" and "the server heard about it".
 *
 * Three rules govern everything here, and they all come from the same premise:
 * telemetry is the least important thing this app does. It observes the product;
 * it must never shape it.
 *
 *   1. NEVER THROW. Every entry point swallows its own errors. A telemetry bug
 *      must not break a navigation, a send, or a render.
 *   2. NEVER BLOCK. Nothing awaits a flush on the UI path.
 *   3. NEVER GROW WITHOUT BOUND. A user offline for an hour, or a server that is
 *      down, must not turn into an ever-growing array of unsent events.
 *
 * Kept free of React so it can be tested as plain data-in/data-out.
 */
import type { ActivitySource } from "@taskboard/shared";
import { setSessionId } from "./telemetrySession";

export interface QueuedEvent {
  action: string;
  category: string;
  occurredAt: string;
  surface?: string;
  targetKind?: string;
  targetId?: string;
  durationMs?: number;
  detail?: Record<string, string>;
  /** Generated once, in push(), and never touched again — including by
   *  flush()'s re-queue-on-failure, which resends this exact object. Lets
   *  the server collapse a retried event into a no-op instead of a
   *  duplicate (see migrations/0006_activity_event_idempotency.sql in
   *  telemetry-svc). Mirrors apps/desktop/src/main/activity-agent.ts's own
   *  clientEventId. */
  clientEventId: string;
}

export interface FlushPayload {
  sessionId: string | null;
  source: ActivitySource & ("web" | "desktop");
  activeMs: number;
  idleMs: number;
  ended: boolean;
  events: QueuedEvent[];
  /** Identifies THIS batch's activeMs/idleMs delta — distinct from each
   *  event's own clientEventId above. Generated once per flush attempt (see
   *  flush()'s pendingRetry) and resent verbatim, unchanged, if that exact
   *  attempt fails and is retried — never regenerated for a retry, never
   *  reused across two different batches. Lets the server tell "the same
   *  30s resent because the ack was lost" apart from "a genuinely new 30s"
   *  (see migrations/0009_beacon_batch_idempotency.sql in telemetry-svc);
   *  without it a lost ack permanently inflated the session's tracked time. */
  clientEventId: string;
}

/** Flush when the buffer reaches this, without waiting for the timer. */
export const FLUSH_AT = 20;
/**
 * Hard cap. Beyond this the OLDEST events are dropped, not the newest: if a
 * client has been unable to reach the server for an hour, the last few minutes
 * are what someone looking at the timeline actually wants, and the first few are
 * the ones already least likely to matter.
 */
export const MAX_QUEUED = 200;
/** Server-side cap on a single batch (`Beacon.events`, max_length=100). */
export const MAX_PER_FLUSH = 100;
/**
 * After a failed attempt, wait this long before the next one, doubling per
 * consecutive failure up to the cap. Without it a client that cannot reach the
 * server retries on every flush timer and heartbeat, and the browser logs each
 * failed request to the console. The cap stays well under the server's
 * three-minute session timeout so a reconnecting client is back on the record
 * before it reads as gone.
 */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 120_000;

export class TelemetryQueue {
  private events: QueuedEvent[] = [];
  private activeMs = 0;
  private idleMs = 0;
  private dropped = 0;
  private inFlight = false;
  /**
   * A previously-failed flush attempt's exact payload, frozen — same
   * clientEventId, same activeMs/idleMs/events — until it either succeeds or
   * fails again. Activity that happens WHILE a retry is pending accrues
   * separately in `events`/`activeMs`/`idleMs` above and is never folded
   * into it: doing so would let genuinely new time ride the same
   * clientEventId as time the server might already have applied, defeating
   * the dedup this exists for. See flush().
   */
  private pendingRetry: FlushPayload | null = null;
  private failures = 0;
  private retryNotBefore = 0;
  sessionId: string | null = null;

  /**
   * `isReady` is asked before each ordinary flush and answers whether a beacon
   * sent now has any chance of landing (online, holding a live token). False
   * skips the attempt entirely — nothing is dequeued or lost — instead of
   * making a request that is certain to fail.
   */
  constructor(
    private readonly send: (payload: FlushPayload) => Promise<{ sessionId: string }>,
    private readonly source: "web" | "desktop" = "web",
    private readonly isReady: () => Promise<boolean> = async () => true,
  ) {}

  get size(): number {
    return this.events.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  push(event: Omit<QueuedEvent, "clientEventId">): void {
    this.events.push({ ...event, clientEventId: crypto.randomUUID() });
    if (this.events.length > MAX_QUEUED) {
      this.dropped += this.events.length - MAX_QUEUED;
      this.events = this.events.slice(-MAX_QUEUED);
    }
  }

  addTime(activeMs: number, idleMs: number): void {
    this.activeMs += Math.max(0, activeMs);
    this.idleMs += Math.max(0, idleMs);
  }

  private get hasSomethingToSend(): boolean {
    return this.pendingRetry !== null || this.events.length > 0 || this.activeMs > 0 || this.idleMs > 0;
  }

  get shouldFlush(): boolean {
    return this.events.length >= FLUSH_AT;
  }

  /**
   * Send what we have. Resolves true if the server accepted it.
   *
   * A pending retry (see `pendingRetry`) is always sent before anything new —
   * ordering is preserved and the failed attempt's identity (clientEventId)
   * is never disturbed by newer activity. Once there is nothing left to
   * retry, a fresh batch is built and given its own clientEventId.
   *
   * `keepalive` sends even an EMPTY batch. Ordinarily the accrued active/idle
   * time is what makes a quiet heartbeat worth sending; a client whose host
   * accounts for time elsewhere (see PlatformConfig.osActivityTracking) accrues
   * none here, and without this it would fall silent and the server's sweeper
   * would close its session as gone. Every other gate (readiness, backoff,
   * single-flight) still applies.
   */
  async flush(opts: { ended?: boolean; keepalive?: boolean } = {}): Promise<boolean> {
    if (this.inFlight) return false;

    // The goodbye (pagehide / sign-out) skips both gates: there is no later
    // attempt to defer to, and a wasted one costs nothing.
    if (!opts.ended) {
      // Nothing to say, or still backing off: don't even ask the gate, which
      // may itself go to the network to refresh a token.
      if ((!this.hasSomethingToSend && !opts.keepalive) || Date.now() < this.retryNotBefore) return false;
      // Hold the single-flight slot across the await so a second timer firing
      // meanwhile cannot slip past the check above and double-send.
      this.inFlight = true;
      let ready = false;
      try {
        ready = await this.isReady();
      } catch {
        // A throwing gate must not break the never-throw contract; treat it
        // as "not ready".
      } finally {
        this.inFlight = false;
      }
      if (!ready) {
        this.backOff();
        return false;
      }
    }

    let payload: FlushPayload;
    if (this.pendingRetry) {
      // A caller asking to close the session now (pagehide / sign-out) must
      // not be silently dropped just because an earlier attempt is still
      // stuck retrying — upgrade `ended` in place. Session-close is
      // idempotent server-side (a no-op if already closed), so doing this
      // without changing activeMs/idleMs/events/clientEventId is safe.
      payload =
        opts.ended && !this.pendingRetry.ended
          ? { ...this.pendingRetry, ended: true }
          : this.pendingRetry;
    } else {
      const batch = this.events.slice(0, MAX_PER_FLUSH);
      const activeMs = this.activeMs;
      const idleMs = this.idleMs;
      // Nothing to say, and not the final goodbye — stay silent rather than
      // heartbeat an empty payload the server would have to write a session row
      // for anyway. (A heartbeat with zero events IS worth sending; the caller
      // signals that by having accrued time.)
      if (!batch.length && !activeMs && !idleMs && !opts.ended && !opts.keepalive) return false;
      payload = {
        sessionId: this.sessionId,
        source: this.source,
        activeMs,
        idleMs,
        ended: opts.ended ?? false,
        events: batch,
        clientEventId: crypto.randomUUID(),
      };
      this.events = this.events.slice(batch.length);
      this.activeMs = 0;
      this.idleMs = 0;
    }

    this.inFlight = true;
    try {
      const ack = await this.send(payload);
      this.pendingRetry = null;
      this.failures = 0;
      this.retryNotBefore = 0;
      // The server may hand back a DIFFERENT id than we sent: when a session has
      // already been closed (swept after this client went quiet), reusing the id
      // would silently drop every further beat. Adopting the new one is what
      // makes a returning client's activity keep landing.
      if (ack?.sessionId && ack.sessionId !== this.sessionId) {
        this.sessionId = ack.sessionId;
        // Tell the sibling tabs too — otherwise each would keep sending the
        // dead id and each would be handed its own replacement, turning one
        // returning client back into N sessions.
        setSessionId(ack.sessionId);
      }
      return true;
    } catch {
      // Freeze this exact attempt for the next flush() call to retry
      // unchanged. Never rethrow.
      this.pendingRetry = payload;
      this.backOff();
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  /** Forget the backoff, e.g. when the browser reports it is back online. */
  clearBackoff(): void {
    this.failures = 0;
    this.retryNotBefore = 0;
  }

  private backOff(): void {
    this.failures += 1;
    this.retryNotBefore =
      Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
  }

  /** Drop everything without sending — used on sign-out, when the queue belongs
   *  to a session that is over and a user who may not be coming back. */
  reset(): void {
    this.events = [];
    this.activeMs = 0;
    this.idleMs = 0;
    this.pendingRetry = null;
    this.sessionId = null;
    this.clearBackoff();
  }
}
