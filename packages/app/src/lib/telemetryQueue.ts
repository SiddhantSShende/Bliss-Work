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
}

export interface FlushPayload {
  sessionId: string | null;
  source: ActivitySource & ("web" | "desktop");
  activeMs: number;
  idleMs: number;
  ended: boolean;
  events: QueuedEvent[];
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

  push(event: QueuedEvent): void {
    this.events.push(event);
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
   * On failure the batch is put BACK at the head of the queue and retried on the
   * next flush — but only once, because `push` re-applies the cap and a
   * permanently failing server would otherwise have every flush re-send an
   * ever-older batch forever.
   */
  async flush(opts: { ended?: boolean } = {}): Promise<boolean> {
    if (this.inFlight) return false;
    const batch = this.events.slice(0, MAX_PER_FLUSH);
    const activeMs = this.activeMs;
    const idleMs = this.idleMs;
    // Nothing to say, and not the final goodbye — stay silent rather than
    // heartbeat an empty payload the server would have to write a session row
    // for anyway. (A heartbeat with zero events IS worth sending; the caller
    // signals that by having accrued time.)
    if (!batch.length && !activeMs && !idleMs && !opts.ended) return false;

    this.inFlight = true;
    this.events = this.events.slice(batch.length);
    this.activeMs = 0;
    this.idleMs = 0;
    try {
      const ack = await this.send({
        sessionId: this.sessionId,
        source: this.source,
        activeMs,
        idleMs,
        ended: opts.ended ?? false,
        events: batch,
      });
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
      // Put the batch back at the head so ordering is preserved, and re-add the
      // time so it is not lost. Never rethrow.
      this.events = [...batch, ...this.events].slice(-MAX_QUEUED);
      this.activeMs += activeMs;
      this.idleMs += idleMs;
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
    this.sessionId = null;
  }
}
