import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, AppIdentity } from "./activity-spans";
import { DEFAULT_MAX_APP_SPAN_MS } from "./activity-spans";
import { createActivityTracker, SAMPLE_INTERVAL_MS, type ActivityTracker, type PowerSource } from "./activity-tracker";

const CHROME: AppIdentity = { name: "chrome.exe", path: "C:\\Chrome\\chrome.exe" };
const CODE: AppIdentity = { name: "Code.exe", path: "C:\\VSCode\\Code.exe" };

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const t = (h: number, m: number, s = 0) => BASE + ((h * 60 + m) * 60 + s) * 1000;

const app = (a: AppIdentity, startedAt: number, endedAt: number): ActivityEvent => ({
  kind: "app", name: a.name, path: a.path, startedAt, endedAt, durationMs: endedAt - startedAt,
});
const idle = (startedAt: number, endedAt: number): ActivityEvent => ({
  kind: "idle", startedAt, endedAt, durationMs: endedAt - startedAt,
});

/** Everything the coordinator touches, as plain controllable values. No Electron, no Windows, no koffi. */
function harness(over: { readForeground?: (at: number) => Promise<AppIdentity | null>; maxAppSpanMs?: number } = {}) {
  const world = { now: t(10, 0), app: CHROME as AppIdentity | null, idleSeconds: 0 };
  const power = new EventEmitter();
  const batches: ActivityEvent[][] = [];
  const tracker: ActivityTracker = createActivityTracker({
    now: () => world.now,
    readForeground: over.readForeground ?? (async () => world.app),
    readIdleSeconds: () => world.idleSeconds,
    power: power as unknown as PowerSource,
    onEvents: (events) => batches.push(events),
    ...(over.maxAppSpanMs !== undefined && { maxAppSpanMs: over.maxAppSpanMs }),
  });
  /** Move the clock and run one sampling pass. */
  const tickAt = async (at: number) => {
    world.now = at;
    await tracker.tick();
  };
  const events = () => batches.flat();
  const emit = (signal: string, at: number) => {
    world.now = at;
    power.emit(signal);
  };
  return { world, power, tracker, batches, events, tickAt, emit };
}

const listenerCount = (power: EventEmitter) =>
  ["lock-screen", "unlock-screen", "suspend", "resume"].reduce((n, e) => n + power.listenerCount(e), 0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("lifecycle", () => {
  it("start registers one listener per power signal and one timer, and samples immediately", async () => {
    const h = harness();
    expect(h.tracker.running).toBe(false);
    h.tracker.start();
    expect(h.tracker.running).toBe(true);
    expect(listenerCount(h.power)).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    h.tracker.stop();
    // The immediate sample opened Chrome; the fake clock never moved, so there is no positive span to report.
    expect(h.events()).toEqual([]);
  });

  it("a repeated start does not duplicate timers or listeners", () => {
    const h = harness();
    h.tracker.start();
    h.tracker.start();
    h.tracker.start();
    expect(listenerCount(h.power)).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop removes every timer and listener, and is idempotent", async () => {
    const h = harness();
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    h.tracker.stop();
    h.tracker.stop();
    expect(h.tracker.running).toBe(false);
    expect(listenerCount(h.power)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not sample after stop, and ignores power signals after stop", async () => {
    const h = harness();
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    h.tracker.stop();
    h.batches.length = 0;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 5);
    h.emit("lock-screen", t(10, 5));
    expect(h.batches).toEqual([]);
  });

  it("samples on the interval", async () => {
    const reads = vi.fn(async () => CHROME);
    const h = harness({ readForeground: reads });
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
    expect(reads).toHaveBeenCalledTimes(4);
    h.tracker.stop();
  });

  it("tick does nothing before start", async () => {
    const reads = vi.fn(async () => CHROME);
    const h = harness({ readForeground: reads });
    await h.tracker.tick();
    expect(reads).not.toHaveBeenCalled();
  });

  it("can be started again after a stop, from a clean slate", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.tracker.stop();
    h.batches.length = 0;

    h.world.now = t(11, 0);
    h.tracker.start(); // its immediate sample opens Chrome at 11:00
    expect(listenerCount(h.power)).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await h.tickAt(t(11, 10));
    h.tracker.stop();
    // Nothing from the first run leaks into the second: Chrome starts at 11:00.
    expect(h.events()).toEqual([app(CHROME, t(11, 0), t(11, 10))]);
  });
});

describe("foreground spans", () => {
  it("produces a completed span when the foreground app changes", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.app = CODE;
    await h.tickAt(t(10, 30));
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 30))]);
    h.tracker.stop();
  });

  it("emits nothing for an unchanged foreground app", async () => {
    const h = harness();
    h.tracker.start();
    for (let s = 0; s <= 60; s += 3) await h.tickAt(t(10, 0, s));
    expect(h.events()).toEqual([]);
    h.tracker.stop();
  });

  it("treats an unreadable foreground as no foreground, and keeps tracking", async () => {
    let fail = false;
    const h = harness({ readForeground: async () => (fail ? Promise.reject(new Error("boom")) : CHROME) });
    h.tracker.start();
    await h.tickAt(t(10, 0));
    fail = true;
    await h.tickAt(t(10, 10));
    fail = false;
    await h.tickAt(t(10, 20));
    h.tracker.stop();
    // Chrome closes when the read fails; the one that reopens at 10:20 is still open (zero elapsed at stop).
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
  });
});

describe("OS idle", () => {
  it("closes the app span at the last input, emits the idle span, and resumes the app on return", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.idleSeconds = 300; // last input was 10:20
    await h.tickAt(t(10, 25));
    h.world.idleSeconds = 5; // input resumed at 10:40:00
    await h.tickAt(t(10, 40, 5));
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 20)), idle(t(10, 20), t(10, 40))]);
    h.tracker.stop();
    expect(h.events().at(-1)).toEqual(app(CHROME, t(10, 40), t(10, 40, 5)));
  });

  it("emits nothing for repeated idle samples", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.idleSeconds = 300;
    await h.tickAt(t(10, 5));
    const before = h.events().length;
    for (const [s, idleS] of [[3, 303], [6, 306], [9, 309]] as const) {
      h.world.idleSeconds = idleS;
      await h.tickAt(t(10, 5, s));
    }
    expect(h.events()).toHaveLength(before);
    h.tracker.stop();
  });

  it("skips a tick whose idle counter cannot be read", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.idleSeconds = Number.NaN; // the machine treats this as active
    await h.tickAt(t(10, 10));
    expect(h.events()).toEqual([]);
    h.tracker.stop();
  });
});

describe("lock / unlock and suspend / resume", () => {
  it("lock closes the open span, pauses sampling, and unlock resumes it", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.emit("lock-screen", t(10, 10));
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 10))]);

    h.world.app = CODE;
    await h.tickAt(t(10, 12)); // behind the lock screen: ignored
    expect(h.events()).toHaveLength(1);

    h.emit("unlock-screen", t(10, 20));
    await h.tickAt(t(10, 20, 3));
    await h.tickAt(t(10, 25));
    h.tracker.stop();
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 10)), app(CODE, t(10, 20, 3), t(10, 25))]);
  });

  it("suspend pauses and resume resumes", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.emit("suspend", t(10, 10));
    await h.tickAt(t(11, 0));
    h.emit("resume", t(12, 0));
    await h.tickAt(t(12, 0, 3));
    await h.tickAt(t(12, 5));
    h.tracker.stop();
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 10)), app(CHROME, t(12, 0, 3), t(12, 5))]);
  });

  it("keeps the flags independent: resume while still locked stays paused", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.emit("lock-screen", t(10, 5));
    h.emit("suspend", t(10, 6));
    h.emit("resume", t(11, 0));
    await h.tickAt(t(11, 0, 3));
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 5))]);

    h.emit("unlock-screen", t(11, 1));
    await h.tickAt(t(11, 1, 3));
    await h.tickAt(t(11, 10));
    h.tracker.stop();
    expect(h.events().at(-1)).toEqual(app(CHROME, t(11, 1, 3), t(11, 10)));
  });
});

describe("accounting", () => {
  it("accounts for every observed minute exactly once: spans never overlap and idle is never app time", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0)); // Chrome
    h.world.idleSeconds = 300;
    await h.tickAt(t(10, 25)); // idle since 10:20
    h.world.idleSeconds = 5;
    await h.tickAt(t(10, 40, 5)); // back at 10:40:00
    h.emit("lock-screen", t(10, 50));
    h.emit("unlock-screen", t(11, 0));
    h.world.idleSeconds = 0;
    await h.tickAt(t(11, 0, 3)); // Chrome again
    h.world.now = t(11, 30);
    h.tracker.stop();

    const spans = [...h.events()].sort((x, y) => x.startedAt - y.startedAt);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.startedAt).toBeGreaterThanOrEqual(spans[i - 1]!.endedAt);

    const ms = (kind: "app" | "idle") => spans.filter((e) => e.kind === kind).reduce((n, e) => n + e.durationMs, 0);
    const MIN = 60_000;
    expect(ms("idle")).toBe(20 * MIN); // 10:20 → 10:40
    expect(ms("app")).toBe(20 * MIN + 10 * MIN + (30 * MIN - 3_000)); // 10:00-10:20, 10:40-10:50, 11:00:03-11:30
    // Tracked time = 10:00 → 11:30 less the 10-minute lock and the 3s before the first post-unlock sample.
    expect(ms("app") + ms("idle")).toBe(90 * MIN - 10 * MIN - 3_000);
  });
});

describe("quit / stop", () => {
  it("flushes the open app span at the stop time", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.now = t(10, 45);
    h.tracker.stop();
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 45))]);
  });

  it("flushes an open idle span at the stop time", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.idleSeconds = 300;
    await h.tickAt(t(10, 15));
    h.world.now = t(10, 45);
    h.tracker.stop();
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 10)), idle(t(10, 10), t(10, 45))]);
  });

  it("delivers the span only once however many times stop is called", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.now = t(10, 45);
    h.tracker.stop();
    h.tracker.stop();
    expect(h.batches).toHaveLength(1);
  });

  it("a read that resolves after stop is dropped without effect", async () => {
    let release: (a: AppIdentity | null) => void = () => {};
    const h = harness({ readForeground: () => new Promise((r) => (release = r)) });
    h.tracker.start(); // its immediate tick is now blocked on the read
    h.tracker.stop();
    release(CHROME);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events()).toEqual([]);
    expect(h.tracker.running).toBe(false);
  });
});

describe("robustness", () => {
  it("a read from a stopped run cannot leak into the run that replaced it", async () => {
    const releases: ((a: AppIdentity | null) => void)[] = [];
    const h = harness({ readForeground: () => new Promise((r) => releases.push(r)) });
    h.world.now = t(10, 0);
    h.tracker.start(); // run 1: read #0 pending
    h.tracker.stop();
    h.world.now = t(11, 0);
    h.tracker.start(); // run 2: read #1 pending
    releases[1]?.(CODE);
    await vi.advanceTimersByTimeAsync(0);
    releases[0]?.(CHROME); // run 1's read finally lands, mid run 2
    await vi.advanceTimersByTimeAsync(0);
    h.world.now = t(11, 10);
    h.tracker.stop();
    expect(h.events()).toEqual([app(CODE, t(11, 0), t(11, 10))]);
  });

  it("does not stack a second read behind a slow one", async () => {
    let release: (a: AppIdentity | null) => void = () => {};
    const reads = vi.fn(() => new Promise<AppIdentity | null>((r) => (release = r)));
    const h = harness({ readForeground: reads });
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 4);
    expect(reads).toHaveBeenCalledTimes(1);
    release(CHROME);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(reads).toHaveBeenCalledTimes(2);
    h.tracker.stop();
  });

  it("a throwing consumer does not stop tracking or a stop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const power = new EventEmitter();
    let now = t(10, 0);
    const tracker = createActivityTracker({
      now: () => now,
      readForeground: async () => CHROME,
      readIdleSeconds: () => 0,
      power: power as unknown as PowerSource,
      onEvents: () => {
        throw new Error("consumer broke");
      },
    });
    tracker.start();
    await vi.advanceTimersByTimeAsync(0); // let the immediate sample open Chrome
    now = t(10, 30);
    expect(() => tracker.stop()).not.toThrow();
    expect(tracker.running).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("rollover through the coordinator", () => {
  const MIN = 60_000;

  it("the production default is five minutes", () => {
    expect(DEFAULT_MAX_APP_SPAN_MS).toBe(5 * MIN);
  });

  it("delivers a long unchanged span in instalments as it goes, not all at the end", async () => {
    const h = harness({ maxAppSpanMs: DEFAULT_MAX_APP_SPAN_MS });
    h.tracker.start();
    await h.tickAt(t(10, 0));
    for (let at = t(10, 0, 3); at <= t(10, 15); at += 3_000) await h.tickAt(at);
    // Three pieces are out BEFORE any quit: an unclean exit now would lose nothing yet.
    expect(h.batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 5)), app(CHROME, t(10, 5), t(10, 10)), app(CHROME, t(10, 10), t(10, 15))]);
    h.world.now = t(10, 15);
    h.tracker.stop();
    expect(h.events()).toHaveLength(3); // the quit adds no empty span
  });

  it("an unclean exit loses at most the current instalment", async () => {
    const h = harness({ maxAppSpanMs: DEFAULT_MAX_APP_SPAN_MS });
    h.tracker.start();
    await h.tickAt(t(10, 0));
    for (let at = t(10, 0, 3); at <= t(10, 12); at += 3_000) await h.tickAt(at); // never stopped
    expect(h.events().reduce((n, e) => n + e.durationMs, 0)).toBe(10 * MIN);
  });

  it("stop flushes the remainder after a roll, and the pieces sum to the whole period", async () => {
    const h = harness({ maxAppSpanMs: DEFAULT_MAX_APP_SPAN_MS });
    h.tracker.start();
    await h.tickAt(t(10, 0));
    for (let at = t(10, 0, 3); at <= t(10, 8); at += 3_000) await h.tickAt(at);
    h.world.now = t(10, 8);
    h.tracker.stop();
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 5)), app(CHROME, t(10, 5), t(10, 8))]);
  });

  it("does not roll while the OS reports idle, and idle is one span across the boundary", async () => {
    const h = harness({ maxAppSpanMs: DEFAULT_MAX_APP_SPAN_MS });
    h.tracker.start();
    await h.tickAt(t(10, 0));
    h.world.idleSeconds = 300;
    await h.tickAt(t(10, 9)); // last input 10:04
    h.world.idleSeconds = 900;
    await h.tickAt(t(10, 19));
    h.world.idleSeconds = 5;
    await h.tickAt(t(10, 30, 5)); // back at 10:30:00
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 4)), idle(t(10, 4), t(10, 30))]);
    h.tracker.stop();
  });

  it("lock after a roll closes only the remainder, and unlock restarts the interval", async () => {
    const h = harness({ maxAppSpanMs: DEFAULT_MAX_APP_SPAN_MS });
    h.tracker.start();
    await h.tickAt(t(10, 0));
    for (let at = t(10, 0, 3); at <= t(10, 6); at += 3_000) await h.tickAt(at);
    h.emit("lock-screen", t(10, 7));
    h.emit("unlock-screen", t(11, 0));
    await h.tickAt(t(11, 0, 3));
    await h.tickAt(t(11, 5, 3));
    expect(h.events()).toEqual([
      app(CHROME, t(10, 0), t(10, 5)),
      app(CHROME, t(10, 5), t(10, 7)),
      app(CHROME, t(11, 0, 3), t(11, 5, 3)),
    ]);
    h.tracker.stop();
  });

  it("rolls nothing unless configured: the existing default behaviour is unchanged", async () => {
    const h = harness();
    h.tracker.start();
    await h.tickAt(t(10, 0));
    await h.tickAt(t(10, 30));
    expect(h.events()).toEqual([]);
    h.world.now = t(10, 31);
    h.tracker.stop();
    expect(h.events()).toEqual([app(CHROME, t(10, 0), t(10, 31))]);
  });
});
