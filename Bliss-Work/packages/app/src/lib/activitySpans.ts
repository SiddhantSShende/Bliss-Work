/**
 * Desktop activity spans → the existing telemetry queue.
 *
 * On a desktop whose main process measures the OS's own idle time
 * (PlatformConfig.osActivityTracking), these spans are the ONLY source of
 * active and idle time — TelemetryBridge banks none of its own there. Each span
 * does two things, once:
 *
 *   an app span   → one `app.focus` event          and  durationMs of ACTIVE time
 *   an idle span  → one `os.idle` event            and  durationMs of IDLE time
 *
 * `os.idle` is deliberately not `idle.start`/`idle.end`: those are the web
 * client's in-window idle (a person reading a long page), a different claim from
 * "the operating system saw no input", and the timeline must be able to tell
 * them apart.
 *
 * Existing categories and fields only — nothing new on the backend. `app` and
 * `engagement` are both categories the beacon already accepts from a client, and
 * the beacon's own limits (a 24h `durationMs`, a 128-character `targetId`) are
 * applied here so one odd span can never get a whole batch rejected.
 *
 * What a span can carry is only what main hands over: an executable name and
 * timestamps. No path, title, URL or content exists on this side to leak.
 *
 * The input crosses an IPC boundary, so it is validated rather than trusted: a
 * malformed entry is skipped, never thrown on and never allowed to poison the
 * accounting.
 */
import type { QueuedEvent } from "./telemetryQueue";

/** The beacon's `durationMs` / `activeMs` / `idleMs` ceiling (telemetry-svc schemas.py). */
const MAX_DURATION_MS = 86_400_000;
/** The beacon's `targetId` ceiling. */
const MAX_TARGET_ID = 128;

export const APP_SPAN_ACTION = "app.focus";
export const IDLE_SPAN_ACTION = "os.idle";

/** The slice of TelemetryQueue this needs. */
export interface SpanSink {
  push(event: Omit<QueuedEvent, "clientEventId">): void;
  addTime(activeMs: number, idleMs: number): void;
}

interface ValidSpan {
  kind: "app" | "idle";
  name: string;
  startedAt: number;
  durationMs: number;
}

function validate(raw: unknown): ValidSpan | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.kind !== "app" && s.kind !== "idle") return null;
  const { startedAt, durationMs } = s;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return null;
  const duration = Math.min(Math.round(durationMs), MAX_DURATION_MS);
  if (duration <= 0) return null;
  let name = "";
  if (s.kind === "app") {
    if (typeof s.name !== "string" || !s.name.trim()) return null;
    name = s.name.trim().slice(0, MAX_TARGET_ID);
  }
  if (Number.isNaN(new Date(startedAt).getTime())) return null;
  return { kind: s.kind, name, startedAt, durationMs: duration };
}

/**
 * Feed a batch of spans from main into `sink`. Returns how many were accepted.
 * Oldest first, so events and time land in the order they happened.
 */
export function ingestActivitySpans(sink: SpanSink, raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const spans = raw.map(validate).filter((s): s is ValidSpan => s !== null);
  spans.sort((a, b) => a.startedAt - b.startedAt);
  for (const span of spans) {
    const occurredAt = new Date(span.startedAt).toISOString();
    if (span.kind === "app") {
      sink.push({
        action: APP_SPAN_ACTION,
        category: "app",
        occurredAt,
        targetKind: "app",
        targetId: span.name,
        durationMs: span.durationMs,
      });
      sink.addTime(span.durationMs, 0);
    } else {
      sink.push({ action: IDLE_SPAN_ACTION, category: "engagement", occurredAt, durationMs: span.durationMs });
      sink.addTime(0, span.durationMs);
    }
  }
  return spans.length;
}
