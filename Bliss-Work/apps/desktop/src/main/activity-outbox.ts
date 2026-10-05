import type { ActivityEvent } from "./activity-spans";

/**
 * Where completed activity spans wait for the renderer to collect them.
 *
 * Main never pushes spans at a window and never talks to the backend: the
 * renderer asks (`activity:drain`) from its existing telemetry timer and feeds
 * what it gets into the TelemetryQueue, which already owns auth, retry and
 * idempotency. Pulling is what makes the awkward moments harmless — a renderer
 * that is reloading, not yet mounted, or signed out simply is not asking, and
 * the spans wait here instead of being sent into the void.
 *
 * Bounded, and in memory only: this is a hand-off, not a second telemetry
 * store. When nobody collects for long enough the OLDEST spans go, the same
 * trade TelemetryQueue makes (the recent minutes are the ones that matter).
 *
 * Every span is tagged with the user it was recorded for, and `drain` returns
 * only the asking user's. Spans from a previous sign-in are DISCARDED, never
 * handed to whoever signs in next — the tracker closes the old user's open span
 * on sign-out, and that span still belongs to the old user.
 *
 * What leaves is the wire shape below: the executable name, never its path.
 */
export const MAX_PENDING_SPANS = 500;

export type ActivitySpanWire =
  | { kind: "app"; name: string; startedAt: number; endedAt: number; durationMs: number }
  | { kind: "idle"; startedAt: number; endedAt: number; durationMs: number };

const toWire = (span: ActivityEvent): ActivitySpanWire =>
  span.kind === "app"
    ? { kind: "app", name: span.name, startedAt: span.startedAt, endedAt: span.endedAt, durationMs: span.durationMs }
    : { kind: "idle", startedAt: span.startedAt, endedAt: span.endedAt, durationMs: span.durationMs };

export interface ActivityOutbox {
  /** Queue spans recorded for `owner`. Ignored when nobody was signed in. */
  push(owner: string | null, spans: ActivityEvent[]): void;
  /** Take `owner`'s spans, oldest first, and discard everyone else's. */
  drain(owner: string | null): ActivitySpanWire[];
  readonly size: number;
}

export function createActivityOutbox(max = MAX_PENDING_SPANS): ActivityOutbox {
  let items: { owner: string; span: ActivityEvent }[] = [];
  return {
    push(owner, spans) {
      if (!owner || spans.length === 0) return;
      items.push(...spans.map((span) => ({ owner, span })));
      if (items.length > max) items = items.slice(-max);
    },
    drain(owner) {
      const mine = owner ? items.filter((i) => i.owner === owner).map((i) => toWire(i.span)) : [];
      items = [];
      return mine;
    },
    get size() {
      return items.length;
    },
  };
}
