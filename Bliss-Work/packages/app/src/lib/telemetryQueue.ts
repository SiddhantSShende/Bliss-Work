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
  sessionId: string | null = null;

  constructor(
    private readonly send: (payload: FlushPayload) => Promise<{ sessionId: string }>,
    private readonly source: "web" | "desktop" = "web",
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
   */
  async flush(opts: { ended?: boolean } = {}): Promise<boolean> {
    if (this.inFlight) return false;

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
      if (!batch.length && !activeMs && !idleMs && !opts.ended) return false;
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
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  /** Drop everything without sending — used on sign-out, when the queue belongs
   *  to a session that is over and a user who may not be coming back. */
  reset(): void {
    this.events = [];
    this.activeMs = 0;
    this.idleMs = 0;
    this.pendingRetry = null;
    this.sessionId = null;
  }
}
