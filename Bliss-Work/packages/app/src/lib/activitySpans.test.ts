import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestActivitySpans, APP_SPAN_ACTION, IDLE_SPAN_ACTION } from "./activitySpans";
import { TelemetryQueue, type FlushPayload } from "./telemetryQueue";

vi.mock("./telemetrySession", () => ({ setSessionId: vi.fn() }));

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const t = (h: number, m: number, s = 0) => BASE + ((h * 60 + m) * 60 + s) * 1000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const app = (name: string, startedAt: number, endedAt: number) => ({
  kind: "app" as const, name, startedAt, endedAt, durationMs: endedAt - startedAt,
});
const idle = (startedAt: number, endedAt: number) => ({
  kind: "idle" as const, startedAt, endedAt, durationMs: endedAt - startedAt,
});

let sent: FlushPayload[];
let queue: TelemetryQueue;

beforeEach(() => {
  sent = [];
  queue = new TelemetryQueue(async (p) => {
    sent.push(p);
    return { sessionId: "s1" };
  }, "desktop");
});

/** Ingest, flush once, and return the single payload that went out. */
async function flushed(raw: unknown): Promise<FlushPayload> {
  ingestActivitySpans(queue, raw);
  await queue.flush();
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe("A. an app span", () => {
  it("becomes one app.focus event at its start, with its exact duration, and active time", async () => {
    const p = await flushed([app("chrome.exe", t(10, 0), t(10, 30))]);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({
      action: APP_SPAN_ACTION,
      category: "app",
      occurredAt: iso(t(10, 0)),
      targetKind: "app",
      targetId: "chrome.exe",
      durationMs: 30 * MIN,
    });
    expect(p.activeMs).toBe(30 * MIN);
    expect(p.idleMs).toBe(0);
  });
});

describe("B. an idle span", () => {
  it("becomes one os.idle event (not idle.start/idle.end) and idle time only", async () => {
    const p = await flushed([idle(t(10, 20), t(10, 40))]);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({
      action: IDLE_SPAN_ACTION,
      category: "engagement",
      occurredAt: iso(t(10, 20)),
      durationMs: 20 * MIN,
    });
    expect(p.events[0]!.action).not.toMatch(/^idle\./);
    expect(p.idleMs).toBe(20 * MIN);
    expect(p.activeMs).toBe(0);
  });
});

describe("C. several spans", () => {
  it("keep their timestamps, and go out in chronological order even if delivered out of order", async () => {
    const p = await flushed([
      app("Code.exe", t(10, 40), t(10, 50)),
      app("chrome.exe", t(10, 0), t(10, 20)),
      idle(t(10, 20), t(10, 40)),
    ]);
    expect(p.events.map((e) => e.occurredAt)).toEqual([iso(t(10, 0)), iso(t(10, 20)), iso(t(10, 40))]);
    expect(p.events.map((e) => e.targetId ?? "idle")).toEqual(["chrome.exe", "idle", "Code.exe"]);
  });
});

describe("D. an app switch", () => {
  it("is two app spans with the right starts, durations and targets", async () => {
    const p = await flushed([app("chrome.exe", t(10, 0), t(10, 30)), app("Code.exe", t(10, 30), t(10, 45))]);
    expect(p.events.map((e) => [e.targetId, e.occurredAt, e.durationMs])).toEqual([
      ["chrome.exe", iso(t(10, 0)), 30 * MIN],
      ["Code.exe", iso(t(10, 30)), 15 * MIN],
    ]);
    expect(p.activeMs).toBe(45 * MIN);
  });
});

describe("E. app → idle → app", () => {
  it("totals active and idle time separately, with idle never counted as active", async () => {
    const p = await flushed([
      app("chrome.exe", t(10, 0), t(10, 20)),
      idle(t(10, 20), t(10, 40)),
      app("chrome.exe", t(10, 40), t(10, 50)),
    ]);
    expect(p.activeMs).toBe(30 * MIN);
    expect(p.idleMs).toBe(20 * MIN);
    expect(p.events).toHaveLength(3);
  });
});

describe("F. no duplicate accounting", () => {
  it("each span is counted once: its duration is in the event AND in exactly one of active/idle", async () => {
    const spans = [app("chrome.exe", t(10, 0), t(10, 20)), idle(t(10, 20), t(10, 40))];
    const p = await flushed(spans);
    const eventMs = p.events.reduce((n, e) => n + (e.durationMs ?? 0), 0);
    expect(p.activeMs + p.idleMs).toBe(eventMs);
  });

  it("a second collection with nothing new adds nothing", async () => {
    ingestActivitySpans(queue, [app("chrome.exe", t(10, 0), t(10, 20))]);
    await queue.flush();
    expect(ingestActivitySpans(queue, [])).toBe(0);
    expect(await queue.flush()).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe("what is accepted from across the IPC boundary", () => {
  it("skips anything that is not a well-formed span, without throwing", async () => {
    const p = await flushed([
      null, 7, "x", {}, { kind: "other", startedAt: 1, durationMs: 5 },
      { kind: "app", startedAt: t(10, 0), durationMs: 5000 }, // no name
      { kind: "app", name: "  ", startedAt: t(10, 0), durationMs: 5000 },
      { kind: "app", name: "a.exe", startedAt: Number.NaN, durationMs: 5000 },
      { kind: "app", name: "a.exe", startedAt: t(10, 0), durationMs: 0 },
      { kind: "app", name: "a.exe", startedAt: t(10, 0), durationMs: -5 },
      { kind: "idle", startedAt: t(10, 0), durationMs: Number.POSITIVE_INFINITY },
      app("ok.exe", t(10, 0), t(10, 1)),
    ]);
    expect(p.events.map((e) => e.targetId)).toEqual(["ok.exe"]);
    expect(p.activeMs).toBe(MIN);
  });

  it("ignores a non-array payload", () => {
    expect(ingestActivitySpans(queue, undefined)).toBe(0);
    expect(ingestActivitySpans(queue, { kind: "app" })).toBe(0);
    expect(queue.size).toBe(0);
  });

  it("keeps within the beacon's limits so one span cannot get a batch rejected", async () => {
    const p = await flushed([
      { kind: "app", name: "x".repeat(500), startedAt: t(10, 0), durationMs: 90_000_000 },
    ]);
    expect(p.events[0]!.targetId).toHaveLength(128);
    expect(p.events[0]!.durationMs).toBe(86_400_000);
    expect(p.activeMs).toBe(86_400_000);
  });

  it("carries only what is needed — no path, title or anything else, even if main sent more", async () => {
    const p = await flushed([
      { ...app("chrome.exe", t(10, 0), t(10, 1)), path: "C:\\Users\\a\\chrome.exe", title: "Secret" },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/Users|Secret|title|path/);
    expect(Object.keys(p.events[0]!).sort()).toEqual(
      ["action", "category", "clientEventId", "durationMs", "occurredAt", "targetId", "targetKind"],
    );
  });
});

describe("K. the queue's retry and idempotency still hold for span events", () => {
  it("a failed send is retried as the same frozen batch: same ids, same time, no double accrual", async () => {
    const attempts: FlushPayload[] = [];
    let fail = true;
    const q = new TelemetryQueue(async (p) => {
      attempts.push(p);
      if (fail) throw new Error("offline");
      return { sessionId: "s1" };
    }, "desktop");

    ingestActivitySpans(q, [app("chrome.exe", t(10, 0), t(10, 20)), idle(t(10, 20), t(10, 40))]);
    expect(await q.flush({ keepalive: true })).toBe(false);

    // New spans arrive while the retry is pending: they must not join the frozen attempt.
    ingestActivitySpans(q, [app("Code.exe", t(10, 40), t(10, 50))]);
    fail = false;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000); // past the backoff
    await q.flush();
    await q.flush();
    vi.useRealTimers();

    const [first, retry, next] = attempts;
    expect(retry!.clientEventId).toBe(first!.clientEventId);
    expect(retry!.events.map((e) => e.clientEventId)).toEqual(first!.events.map((e) => e.clientEventId));
    expect(retry!.activeMs).toBe(20 * MIN);
    expect(retry!.idleMs).toBe(20 * MIN);
    // The span that arrived mid-retry goes out afterwards, on its own identity.
    expect(next!.clientEventId).not.toBe(first!.clientEventId);
    expect(next!.activeMs).toBe(10 * MIN);
    expect(next!.idleMs).toBe(0);
  });

  it("every event gets its own idempotency id", async () => {
    const p = await flushed([app("a.exe", t(10, 0), t(10, 1)), app("b.exe", t(10, 1), t(10, 2))]);
    expect(new Set(p.events.map((e) => e.clientEventId)).size).toBe(2);
  });
});
