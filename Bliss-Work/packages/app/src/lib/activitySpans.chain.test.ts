import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The REAL desktop modules, not stand-ins: this pins the seam between main and
// the renderer (the IPC wire shape), which neither side's own tests cross.
import { createActivityTracker, type PowerSource } from "../../../../apps/desktop/src/main/activity-tracker";
import { createActivityOutbox } from "../../../../apps/desktop/src/main/activity-outbox";
import type { AppIdentity } from "../../../../apps/desktop/src/main/activity-spans";
import { ingestActivitySpans } from "./activitySpans";
import { TelemetryQueue, type FlushPayload } from "./telemetryQueue";

const CHROME: AppIdentity = { name: "chrome.exe", path: "C:\\Program Files\\Google\\Chrome\\chrome.exe" };
const BLISS: AppIdentity = { name: "BlissWork.exe", path: "C:\\Users\\a\\AppData\\Local\\Programs\\BlissWork\\BlissWork.exe" };
const CODE: AppIdentity = { name: "Code.exe", path: "C:\\Users\\a\\AppData\\Local\\Programs\\VSCode\\Code.exe" };

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const at = (h: number, m: number, s = 0) => BASE + ((h * 60 + m) * 60 + s) * 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** One working morning, driven through every stage a span passes before the server sees it. */
async function run() {
  const world = { now: at(10, 0), app: CHROME as AppIdentity | null, idleSeconds: 0 };
  const power = new EventEmitter();
  const outbox = createActivityOutbox();
  const tracker = createActivityTracker({
    now: () => world.now,
    readForeground: async () => world.app,
    readIdleSeconds: () => world.idleSeconds,
    power: power as unknown as PowerSource,
    onEvents: (spans) => outbox.push("user-1", spans),
  });
  const step = async (time: number, app: AppIdentity | null = world.app, idleSeconds = 0) => {
    Object.assign(world, { now: time, app, idleSeconds });
    await tracker.tick();
  };

  tracker.start();
  await vi.advanceTimersByTimeAsync(0); // the immediate first sample
  await step(at(10, 5), BLISS); // Chrome → BlissWork
  await step(at(10, 10), CHROME); // BlissWork → Chrome
  await step(at(10, 10, 3), CODE); // a 3-second look at Chrome, then VS Code
  world.now = at(10, 20);
  power.emit("lock-screen"); // closes VS Code; nothing is tracked while locked
  await step(at(10, 25)); // sampled while locked: ignored
  world.now = at(10, 30);
  power.emit("unlock-screen");
  await step(at(10, 30, 3), CODE);
  await step(at(10, 50), CODE, 300); // idle threshold reached: idle began at 10:45
  await step(at(10, 55), CODE, 0); // back at the keyboard
  world.now = at(10, 56);
  tracker.stop();

  // What crosses the IPC boundary is structured-cloned, i.e. plain data.
  const wire = JSON.parse(JSON.stringify(outbox.drain("user-1")));
  const sent: FlushPayload[] = [];
  const queue = new TelemetryQueue(async (p) => (sent.push(p), { sessionId: "s1" }), "desktop");
  const accepted = ingestActivitySpans(queue, wire);
  expect(await queue.flush()).toBe(true);
  return { wire, accepted, payload: sent[0]! };
}

describe("desktop span → beacon payload, through the real tracker, outbox and ingest", () => {
  it("carries every external application and BlissWork as app.focus events with exact durations", async () => {
    const { payload } = await run();
    const apps = payload.events.filter((e) => e.action === "app.focus");
    expect(apps.map((e) => [e.targetId, e.durationMs])).toEqual([
      ["chrome.exe", 5 * 60_000],
      ["BlissWork.exe", 5 * 60_000], // classified by the server (settings.in_app_executables), not dropped here
      ["chrome.exe", 3_000], // the short span survives
      ["Code.exe", 9 * 60_000 + 57_000],
      ["Code.exe", 14 * 60_000 + 57_000], // 10:30:03 → idle began 10:45
      ["Code.exe", 60_000],
    ]);
    for (const e of apps) {
      expect(e.category).toBe("app");
      expect(e.targetKind).toBe("app");
    }
  });

  it("stamps each event at its span's start, oldest first", async () => {
    const { payload } = await run();
    const starts = payload.events.map((e) => e.occurredAt);
    expect(starts[0]).toBe(new Date(at(10, 0)).toISOString());
    expect(starts).toEqual([...starts].sort());
  });

  it("turns the idle period into one os.idle event and idle time, not app time", async () => {
    const { payload } = await run();
    const idle = payload.events.filter((e) => e.action === "os.idle");
    expect(idle.map((e) => [e.category, e.durationMs, e.occurredAt])).toEqual([
      ["engagement", 10 * 60_000, new Date(at(10, 45)).toISOString()],
    ]);
    expect(payload.idleMs).toBe(10 * 60_000);
  });

  it("books the locked period as nothing: no span, no active time, no idle time", async () => {
    const { payload } = await run();
    const spans = payload.events.filter((e) => e.durationMs !== undefined);
    // 10:20 lock → 10:30:03 unlock-and-sample is absent from every span…
    const lockedStart = at(10, 20);
    const lockedEnd = at(10, 30, 3);
    for (const e of spans) {
      const start = Date.parse(e.occurredAt);
      const end = start + (e.durationMs ?? 0);
      expect(end <= lockedStart || start >= lockedEnd).toBe(true);
    }
    // …and active time is exactly the app spans, once.
    const appMs = payload.events.filter((e) => e.action === "app.focus").reduce((n, e) => n + (e.durationMs ?? 0), 0);
    expect(payload.activeMs).toBe(appMs);
    expect(payload.activeMs + payload.idleMs).toBe(appMs + 10 * 60_000);
  });

  it("sends the executable name only: no path, title or anything else, on the wire or in the payload", async () => {
    const { wire, payload } = await run();
    expect(JSON.stringify(wire)).not.toMatch(/Program Files|AppData|\\\\/);
    expect(JSON.stringify(payload)).not.toMatch(/Program Files|AppData|\\\\/);
    for (const s of wire) expect(Object.keys(s).sort()).toEqual(
      s.kind === "app" ? ["durationMs", "endedAt", "kind", "name", "startedAt"] : ["durationMs", "endedAt", "kind", "startedAt"],
    );
  });

  it("accepts every span main produced", async () => {
    const { wire, accepted } = await run();
    expect(accepted).toBe(wire.length);
    expect(wire).toHaveLength(7); // six app spans and one idle span
  });
});
