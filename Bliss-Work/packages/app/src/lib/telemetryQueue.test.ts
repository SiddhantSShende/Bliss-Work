import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, TelemetryQueue, type FlushPayload } from "./telemetryQueue";

vi.mock("./telemetrySession", () => ({ setSessionId: vi.fn() }));

const ack = { sessionId: "s1" };

function queueWith(opts: {
  send?: (p: FlushPayload) => Promise<{ sessionId: string }>;
  isReady?: () => Promise<boolean>;
} = {}) {
  const send = vi.fn(opts.send ?? (async () => ack));
  const isReady = vi.fn(opts.isReady ?? (async () => true));
  const queue = new TelemetryQueue(send, "web", isReady);
  queue.push({ action: "route.enter", category: "navigation", occurredAt: new Date().toISOString() });
  return { queue, send, isReady };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T09:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("TelemetryQueue readiness gate", () => {
  it("sends nothing and loses nothing while the gate says not ready", async () => {
    const { queue, send } = queueWith({ isReady: async () => false });

    expect(await queue.flush()).toBe(false);

    expect(send).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  it("does not consult the gate when there is nothing to send", async () => {
    const { queue, isReady } = queueWith();
    await queue.flush(); // drains the one queued event

    await queue.flush();

    expect(isReady).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing gate as not ready instead of throwing", async () => {
    const { queue, send } = queueWith({
      isReady: async () => {
        throw new Error("boom");
      },
    });

    await expect(queue.flush()).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets the goodbye through even when the gate says no", async () => {
    const { queue, send, isReady } = queueWith({ isReady: async () => false });

    expect(await queue.flush({ ended: true })).toBe(true);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].ended).toBe(true);
    expect(isReady).not.toHaveBeenCalled();
  });

  it("stays single-flight while the gate is still pending", async () => {
    let release!: (ready: boolean) => void;
    const { queue, send } = queueWith({ isReady: () => new Promise<boolean>((r) => (release = r)) });

    const first = queue.flush();
    const second = await queue.flush();
    release(true);
    await first;

    expect(second).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("TelemetryQueue backoff", () => {
  it("does not retry inside the backoff window, then retries the same batch", async () => {
    let fail = true;
    const { queue, send } = queueWith({
      send: async () => {
        if (fail) throw new Error("net::ERR_NAME_NOT_RESOLVED");
        return ack;
      },
    });

    await queue.flush();
    const firstAttempt = send.mock.calls[0]![0];
    fail = false;

    vi.advanceTimersByTime(BACKOFF_BASE_MS - 1);
    expect(await queue.flush()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(await queue.flush()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    // The retry is the frozen original, so the server can still dedupe it.
    expect(send.mock.calls[1]![0].clientEventId).toBe(firstAttempt.clientEventId);
  });

  it("doubles per consecutive failure and stops at the cap", async () => {
    const { queue, send } = queueWith({
      send: async () => {
        throw new Error("down");
      },
    });

    await queue.flush(); // 1st failure → wait BASE
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    await queue.flush(); // 2nd failure → wait 2×BASE, capped
    expect(BACKOFF_BASE_MS * 2).toBeGreaterThanOrEqual(BACKOFF_MAX_MS);

    vi.advanceTimersByTime(BACKOFF_MAX_MS - 1);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("backs off after a not-ready answer too", async () => {
    let ready = false;
    const { queue, isReady } = queueWith({ isReady: async () => ready });

    await queue.flush();
    ready = true;
    await queue.flush();
    expect(isReady).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(await queue.flush()).toBe(true);
  });

  it("clearBackoff (browser back online) allows an immediate retry", async () => {
    let ready = false;
    const { queue, send } = queueWith({ isReady: async () => ready });
    await queue.flush();
    ready = true;

    queue.clearBackoff();

    expect(await queue.flush()).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("forgets the backoff after a success", async () => {
    let fail = true;
    const { queue, send } = queueWith({
      send: async () => {
        if (fail) throw new Error("down");
        return ack;
      },
    });
    await queue.flush();
    fail = false;
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    await queue.flush(); // succeeds

    queue.push({ action: "focus", category: "engagement", occurredAt: new Date().toISOString() });

    expect(await queue.flush()).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("TelemetryQueue keepalive (hosts that account for time elsewhere)", () => {
  const bareQueue = (opts: { isReady?: () => Promise<boolean> } = {}) => {
    const send = vi.fn(async (_p: FlushPayload) => ack);
    return { queue: new TelemetryQueue(send, "desktop", opts.isReady), send };
  };

  it("an empty queue sends nothing without keepalive", async () => {
    const { queue, send } = bareQueue();
    expect(await queue.flush()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("an empty queue sends one empty beacon with keepalive, so the session stays alive", async () => {
    const { queue, send } = bareQueue();
    expect(await queue.flush({ keepalive: true })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent).toMatchObject({ activeMs: 0, idleMs: 0, events: [], ended: false });
    expect(sent.clientEventId).toBeTruthy();
  });

  it("still honours the readiness gate", async () => {
    const { queue, send } = bareQueue({ isReady: async () => false });
    expect(await queue.flush({ keepalive: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("still honours backoff after a failure", async () => {
    const send = vi.fn(async (_p: FlushPayload): Promise<{ sessionId: string }> => {
      throw new Error("down");
    });
    const queue = new TelemetryQueue(send, "desktop");
    expect(await queue.flush({ keepalive: true })).toBe(false); // fails, backs off
    expect(await queue.flush({ keepalive: true })).toBe(false); // inside the backoff window
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    await queue.flush({ keepalive: true });
    expect(send).toHaveBeenCalledTimes(2);
    // The retry resends the SAME frozen attempt rather than minting a new batch.
    expect(send.mock.calls[1]![0].clientEventId).toBe(send.mock.calls[0]![0].clientEventId);
  });

  it("carries real events and time unchanged when there are some", async () => {
    const { queue, send } = bareQueue();
    queue.push({ action: "route.enter", category: "navigation", occurredAt: new Date().toISOString() });
    queue.addTime(1000, 500);
    await queue.flush({ keepalive: true });
    expect(send.mock.calls[0]![0]).toMatchObject({ activeMs: 1000, idleMs: 500 });
    expect(send.mock.calls[0]![0].events).toHaveLength(1);
  });
});
