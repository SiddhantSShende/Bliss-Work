import { describe, expect, it } from "vitest";
import { createActivityOutbox, MAX_PENDING_SPANS } from "./activity-outbox";
import type { ActivityEvent } from "./activity-spans";

const app = (name: string, startedAt: number, endedAt: number): ActivityEvent => ({
  kind: "app", name, path: `C:\\Users\\someone\\${name}`, startedAt, endedAt, durationMs: endedAt - startedAt,
});
const idle = (startedAt: number, endedAt: number): ActivityEvent => ({
  kind: "idle", startedAt, endedAt, durationMs: endedAt - startedAt,
});

describe("activity outbox", () => {
  it("hands a user's spans over once, oldest first, then is empty", () => {
    const box = createActivityOutbox();
    box.push("alice", [app("chrome.exe", 0, 10)]);
    box.push("alice", [idle(10, 40), app("Code.exe", 40, 50)]);
    expect(box.drain("alice").map((s) => s.kind)).toEqual(["app", "idle", "app"]);
    expect(box.drain("alice")).toEqual([]);
    expect(box.size).toBe(0);
  });

  it("sends the executable name and timing only — never the path", () => {
    const box = createActivityOutbox();
    box.push("alice", [app("chrome.exe", 0, 10)]);
    const [span] = box.drain("alice");
    expect(span).toEqual({ kind: "app", name: "chrome.exe", startedAt: 0, endedAt: 10, durationMs: 10 });
    expect(JSON.stringify(span)).not.toContain("Users");
  });

  it("never hands one user's spans to another, and discards them", () => {
    const box = createActivityOutbox();
    box.push("alice", [app("chrome.exe", 0, 10)]); // closed by the sign-out
    expect(box.drain("bob")).toEqual([]);
    // Bob's drain removed them: Alice signing back in does not get stale spans either.
    expect(box.drain("alice")).toEqual([]);
  });

  it("returns only the asker's spans when two users' are mixed", () => {
    const box = createActivityOutbox();
    box.push("alice", [app("chrome.exe", 0, 10)]);
    box.push("bob", [app("Code.exe", 20, 30)]);
    expect(box.drain("bob")).toEqual([{ kind: "app", name: "Code.exe", startedAt: 20, endedAt: 30, durationMs: 10 }]);
  });

  it("ignores spans recorded while nobody was signed in, and gives a signed-out asker nothing", () => {
    const box = createActivityOutbox();
    box.push(null, [app("chrome.exe", 0, 10)]);
    expect(box.size).toBe(0);
    box.push("alice", [app("chrome.exe", 0, 10)]);
    expect(box.drain(null)).toEqual([]);
    expect(box.size).toBe(0);
  });

  it("is bounded: when nobody collects, the oldest spans are dropped", () => {
    const box = createActivityOutbox(3);
    for (let i = 0; i < 5; i++) box.push("alice", [app("a.exe", i * 10, i * 10 + 5)]);
    expect(box.size).toBe(3);
    expect(box.drain("alice").map((s) => s.startedAt)).toEqual([20, 30, 40]);
    expect(MAX_PENDING_SPANS).toBeGreaterThan(100);
  });

  it("holds spans while no renderer is asking (reload, not yet mounted) and delivers them when one does", () => {
    const box = createActivityOutbox();
    box.push("alice", [app("chrome.exe", 0, 10)]);
    box.push("alice", [app("Code.exe", 10, 20)]); // renderer reloading — nothing is sent anywhere
    expect(box.size).toBe(2);
    expect(box.drain("alice")).toHaveLength(2);
  });
});
