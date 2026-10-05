import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../store/session";
import type { FlushPayload } from "./telemetryQueue";

const mocks = vi.hoisted(() => ({
  /** Awaited inside the readiness gate, so a test can hold a flush open mid-flight. */
  gate: Promise.resolve() as Promise<void>,
  api: { sendBeacon: vi.fn() },
  config: { authBase: "", persistToken: () => {}, getRefreshToken: () => null } as {
    authBase: string;
    persistToken: () => void;
    getRefreshToken: () => string | null;
    osActivityTracking?: boolean;
    drainActivitySpans?: () => Promise<unknown>;
  },
}));

vi.mock("./runtime", () => ({ useRuntime: () => ({ api: mocks.api, config: mocks.config }) }));
vi.mock("./refresh", () => ({
  ensureFreshSession: async () => {
    await mocks.gate;
    return true;
  },
}));
vi.mock("./telemetrySession", () => ({
  getSessionId: () => "s1",
  setSessionId: vi.fn(),
  endSession: vi.fn(),
  installTelemetrySession: () => () => {},
  onSessionIdChange: () => () => {},
}));

import { TelemetryBridge, endTelemetrySession } from "./telemetry";

const MIN = 60_000;
let payloads: FlushPayload[];

function mount() {
  return render(
    <MemoryRouter initialEntries={["/app/tasks"]}>
      <TelemetryBridge />
    </MemoryRouter>,
  );
}

const sum = (key: "activeMs" | "idleMs") => payloads.reduce((n, p) => n + p[key], 0);
const actions = () => payloads.flatMap((p) => p.events.map((e) => e.action));

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T09:00:00Z"));
  payloads = [];
  mocks.api.sendBeacon.mockReset();
  mocks.api.sendBeacon.mockImplementation(async (p: FlushPayload) => {
    payloads.push(p);
    return { sessionId: "s1", accepted: p.events.length };
  });
  mocks.gate = Promise.resolve();
  mocks.config.osActivityTracking = undefined;
  mocks.config.drainActivitySpans = undefined;
  setVisibility("visible");
  useSession.setState({ status: "authed" });
});

afterEach(() => {
  vi.useRealTimers();
  useSession.setState({ status: "loading" });
});

describe("TelemetryBridge — web (renderer measures idle itself, unchanged)", () => {
  it("accrues active time while there is input and none as idle", async () => {
    mount();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      fireEvent.pointerDown(window);
    }
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sum("activeMs")).toBeGreaterThan(2 * MIN);
    expect(sum("idleMs")).toBe(0);
    expect(actions()).not.toContain("idle.start");
  });

  it("declares idle after five quiet minutes: idle.start is emitted and idle time accrues", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(8 * MIN);
    expect(actions()).toContain("idle.start");
    expect(sum("idleMs")).toBeGreaterThan(2 * MIN);
    expect(sum("activeMs")).toBeGreaterThan(4 * MIN);
  });

  it("emits section and focus/blur events too — the same set desktop keeps", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    act(() => setVisibility("hidden"));
    await vi.advanceTimersByTimeAsync(MIN);
    act(() => setVisibility("visible"));
    await vi.advanceTimersByTimeAsync(MIN);
    expect(actions()).toEqual(expect.arrayContaining(["route.enter", "blur", "focus"]));
  });

  it("emits idle.end when input returns", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(8 * MIN);
    fireEvent.pointerDown(window);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(actions()).toContain("idle.end");
  });

  it("never sends an empty beacon (no keepalive): a quiet, hidden-free session is always accruing instead", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every((p) => p.activeMs > 0 || p.idleMs > 0 || p.events.length > 0)).toBe(true);
  });
});

describe("TelemetryBridge — desktop with OS-level activity tracking", () => {
  beforeEach(() => {
    mocks.config.osActivityTracking = true;
  });

  it("accrues no active or idle time of its own, however long the window sits quiet", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(sum("activeMs")).toBe(0);
    expect(sum("idleMs")).toBe(0);
  });

  it("accrues none even with in-window input", async () => {
    mount();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      fireEvent.pointerDown(window);
      fireEvent.keyDown(window);
    }
    expect(sum("activeMs")).toBe(0);
    expect(sum("idleMs")).toBe(0);
  });

  it("emits no idle.start / idle.end of its own", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    fireEvent.pointerDown(window);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(actions().filter((a) => a.startsWith("idle."))).toEqual([]);
  });

  it("registers no input listeners and no idle timer", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { unmount } = mount();
    const inputEvents = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];
    expect(add.mock.calls.filter(([type]) => inputEvents.includes(type)).length).toBe(0);
    // flush + heartbeat only; the 30s idle poll is not started.
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    add.mockRestore();
  });

  it("still asserts presence with empty keepalive beacons, so the session is not swept", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const empty = payloads.filter((p) => !p.events.length && p.activeMs === 0 && p.idleMs === 0);
    expect(empty.length).toBeGreaterThanOrEqual(4);
    // Never a longer silence than the server's three-minute timeout.
    expect(payloads.length).toBeGreaterThanOrEqual(5 * 2 - 1);
  });

  it("keeps the non-accounting events: section enter and window focus/blur", async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    act(() => setVisibility("hidden"));
    await vi.advanceTimersByTimeAsync(MIN);
    act(() => setVisibility("visible"));
    await vi.advanceTimersByTimeAsync(MIN);
    expect(actions()).toEqual(expect.arrayContaining(["route.enter", "blur", "focus"]));
  });
});

// ── Desktop: main-process spans become the active/idle accounting ───────────
const BASE = Date.UTC(2026, 0, 5, 10, 0, 0);
const at = (min: number) => BASE + min * MIN;
const app = (name: string, from: number, to: number) => ({
  kind: "app", name, startedAt: at(from), endedAt: at(to), durationMs: (to - from) * MIN,
});
const idleSpan = (from: number, to: number) => ({
  kind: "idle", startedAt: at(from), endedAt: at(to), durationMs: (to - from) * MIN,
});

/** A drain that hands out `batches` one per call, then nothing — as main's outbox does. */
function drainOf(...batches: unknown[][]) {
  const queue = [...batches];
  const fn = vi.fn(async () => queue.shift() ?? []);
  mocks.config.drainActivitySpans = fn;
  return fn;
}
const events = (action: string) => payloads.flatMap((p) => p.events).filter((e) => e.action === action);

describe("TelemetryBridge — desktop: main-process spans are the accounting", () => {
  beforeEach(() => {
    mocks.config.osActivityTracking = true;
  });

  it("A+B+E. app → idle → app arrive as events and as exactly the right active/idle totals", async () => {
    drainOf([app("chrome.exe", 0, 20), idleSpan(20, 40), app("chrome.exe", 40, 50)]);
    mount();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sum("activeMs")).toBe(30 * MIN);
    expect(sum("idleMs")).toBe(20 * MIN);
    expect(events("app.focus").map((e) => [e.targetId, e.durationMs])).toEqual([
      ["chrome.exe", 20 * MIN],
      ["chrome.exe", 10 * MIN],
    ]);
    expect(events("os.idle")).toHaveLength(1);
  });

  it("D. an app switch produces two correct app events, in order", async () => {
    drainOf([app("chrome.exe", 0, 30), app("Code.exe", 30, 45)]);
    mount();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(events("app.focus").map((e) => [e.targetId, e.occurredAt])).toEqual([
      ["chrome.exe", new Date(at(0)).toISOString()],
      ["Code.exe", new Date(at(30)).toISOString()],
    ]);
  });

  it("collects whatever main finished before the window was ready, as soon as it mounts", async () => {
    const drain = drainOf([app("chrome.exe", 0, 10)]);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sum("activeMs")).toBe(10 * MIN);
  });

  it("F+J. spans are counted once however many keepalive beacons follow, and keepalives add no time", async () => {
    drainOf([app("chrome.exe", 0, 20), idleSpan(20, 40)]);
    mount();
    await vi.advanceTimersByTimeAsync(10 * MIN); // ~20 beacons, almost all empty keepalives
    expect(payloads.length).toBeGreaterThan(10);
    expect(sum("activeMs")).toBe(20 * MIN);
    expect(sum("idleMs")).toBe(20 * MIN);
    expect(events("app.focus")).toHaveLength(1);
    expect(events("os.idle")).toHaveLength(1);
    expect(payloads.filter((p) => !p.events.length).every((p) => p.activeMs === 0 && p.idleMs === 0)).toBe(true);
  });

  it("does not also accrue the renderer's own time while spans arrive", async () => {
    drainOf([app("chrome.exe", 0, 5)]);
    mount();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      fireEvent.pointerDown(window);
    }
    expect(sum("activeMs")).toBe(5 * MIN);
    expect(sum("idleMs")).toBe(0);
  });

  it("H. a collection that lands while the old user's goodbye is still being sent is discarded", async () => {
    let release: (v: unknown) => void = () => {};
    mocks.config.drainActivitySpans = vi.fn(() => new Promise((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(0);
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    // Hold the goodbye flush open at its readiness gate, then let the collection land inside that window.
    let openGate: () => void = () => {};
    mocks.gate = new Promise<void>((r) => (openGate = r));
    view.unmount(); // sign-out
    release([app("chrome.exe", 0, 30)]);
    await vi.advanceTimersByTimeAsync(0);
    openGate();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(events("app.focus")).toEqual([]);
    expect(sum("activeMs")).toBe(0);
  });

  it("H. the next sign-in starts from a clean queue: the previous user's spans are not re-sent", async () => {
    drainOf([app("chrome.exe", 0, 30)]);
    const first = mount();
    await vi.advanceTimersByTimeAsync(MIN);
    first.unmount();
    payloads.length = 0;

    drainOf(); // main's outbox handed the new user nothing
    mount();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sum("activeMs")).toBe(0);
    expect(events("app.focus")).toEqual([]);
  });

  it("I. a failing collection (window reloading, host busy) does not break telemetry, and recovers", async () => {
    let calls = 0;
    mocks.config.drainActivitySpans = vi.fn(async () => {
      if (++calls <= 2) throw new Error("no handler");
      return calls === 3 ? [app("chrome.exe", 0, 10)] : []; // main hands each span over once
    });
    mount();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(sum("activeMs")).toBe(10 * MIN);
    expect(payloads.length).toBeGreaterThan(0); // presence carried on throughout
  });

  it("sign-out takes the spans main has already finished before closing the session", async () => {
    drainOf([app("chrome.exe", 0, 10)]);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    payloads.length = 0;
    drainOf([idleSpan(10, 20)]);
    await endTelemetrySession();
    const goodbye = payloads.at(-1)!;
    expect(goodbye.ended).toBe(true);
    expect(goodbye.idleMs).toBe(10 * MIN);
  });

  it("without a drain function it still runs (presence only), and never throws", async () => {
    mocks.config.drainActivitySpans = undefined;
    mount();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(sum("activeMs")).toBe(0);
    expect(payloads.length).toBeGreaterThan(0);
  });
});

describe("TelemetryBridge — G. web is untouched by the span path", () => {
  it("never collects spans, even if a host offered the function, and keeps its own accounting", async () => {
    const drain = drainOf([app("chrome.exe", 0, 30)]);
    mocks.config.osActivityTracking = undefined;
    mount();
    await vi.advanceTimersByTimeAsync(8 * MIN);
    expect(drain).not.toHaveBeenCalled();
    expect(events("app.focus")).toEqual([]);
    expect(actions()).toContain("idle.start");
    expect(sum("activeMs")).toBeGreaterThan(4 * MIN);
    expect(sum("activeMs")).toBeLessThan(30 * MIN);
  });
});
