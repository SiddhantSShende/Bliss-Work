/**
 * The queue's guarantees, which exist because telemetry is the least important
 * thing this app does: it must never throw, never block, and never grow without
 * bound. A regression in any of the three turns an observer into a liability.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PER_FLUSH,
  MAX_QUEUED,
  TelemetryQueue,
  type FlushPayload,
} from "./telemetryQueue";

vi.mock("./telemetrySession", () => ({ setSessionId: vi.fn() }));

const evt = (action: string) => ({
  action,
  category: "navigation",
  occurredAt: "2026-08-13T09:00:00.000Z",
});

function makeQueue(send: (p: FlushPayload) => Promise<{ sessionId: string }>) {
  return new TelemetryQueue(send, "web");
}

describe("TelemetryQueue", () => {
  let sent: FlushPayload[];

  beforeEach(() => {
    sent = [];
  });

  const ok = async (p: FlushPayload) => {
    sent.push(p);
    return { sessionId: "s1" };
  };

  it("sends what it has been given", async () => {
    const q = makeQueue(ok);
    q.push(evt("route.enter"));
    q.addTime(1000, 0);
    expect(await q.flush()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toHaveLength(1);
    expect(sent[0]!.activeMs).toBe(1000);
  });

  it("stays silent when there is nothing to say", async () => {
    const q = makeQueue(ok);
    expect(await q.flush()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("still speaks on the final goodbye, even with an empty buffer", async () => {
    // pagehide with nothing buffered must still close the session, or it lingers
    // until the sweeper times it out three minutes later.
    const q = makeQueue(ok);
    expect(await q.flush({ ended: true })).toBe(true);
    expect(sent[0]!.ended).toBe(true);
  });

  it("caps the buffer and drops the OLDEST events", () => {
    const q = makeQueue(ok);
    for (let i = 0; i < MAX_QUEUED + 50; i++) q.push(evt(`e${i}`));
    expect(q.size).toBe(MAX_QUEUED);
    expect(q.droppedCount).toBe(50);
  });

  it("never sends more than the server's per-batch cap", async () => {
    const q = makeQueue(ok);
    for (let i = 0; i < MAX_QUEUED; i++) q.push(evt(`e${i}`));
    await q.flush();
    expect(sent[0]!.events.length).toBeLessThanOrEqual(MAX_PER_FLUSH);
  });

  it("does not throw when the server is unreachable", async () => {
    const q = makeQueue(async () => {
      throw new Error("network down");
    });
    q.push(evt("route.enter"));
    await expect(q.flush()).resolves.toBe(false);
  });

  it("keeps the batch and the accrued time after a failure", async () => {
    let fail = true;
    const q = makeQueue(async (p) => {
      if (fail) throw new Error("down");
      sent.push(p);
      return { sessionId: "s1" };
    });
    q.push(evt("a"));
    q.addTime(5000, 1000);

    await q.flush();
    expect(q.size).toBe(1); // put back, not lost

    fail = false;
    await q.flush();
    expect(sent[0]!.events.map((e) => e.action)).toEqual(["a"]);
    expect(sent[0]!.activeMs).toBe(5000);
    expect(sent[0]!.idleMs).toBe(1000);
  });

  it("does not overlap flushes", async () => {
    let resolve!: (v: { sessionId: string }) => void;
    const q = makeQueue(() => new Promise((r) => (resolve = r)));
    q.push(evt("a"));
    const first = q.flush();
    q.push(evt("b"));
    // A second flush while one is in flight would send `b` before `a` landed,
    // and on failure both batches would be restored — duplicating `a`.
    expect(await q.flush()).toBe(false);
    resolve({ sessionId: "s1" });
    await first;
  });

  it("adopts the session id the server hands back", async () => {
    // The server replies with a NEW id when the old session was already swept.
    // Ignoring it would mean every later beat is written against a closed
    // session — i.e. silently dropped.
    const q = makeQueue(async (p) => {
      sent.push(p);
      return { sessionId: "server-chosen" };
    });
    q.sessionId = "stale";
    q.push(evt("a"));
    await q.flush();
    expect(q.sessionId).toBe("server-chosen");

    q.push(evt("b"));
    await q.flush();
    expect(sent[1]!.sessionId).toBe("server-chosen");
  });

  it("forgets everything on sign-out", () => {
    const q = makeQueue(ok);
    q.push(evt("a"));
    q.addTime(1000, 0);
    q.sessionId = "s1";
    q.reset();
    expect(q.size).toBe(0);
    expect(q.sessionId).toBeNull();
  });

  it("ignores negative durations rather than crediting time backwards", () => {
    // A clock that steps backwards mid-session (NTP correction, laptop resume)
    // would otherwise subtract from the day's total.
    const q = makeQueue(ok);
    q.addTime(-5000, -5000);
    q.addTime(1000, 0);
    void q.flush();
    expect(q.size).toBe(0);
  });
});
