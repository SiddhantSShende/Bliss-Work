import { describe, expect, it } from "vitest";
import { shouldRefreshSticky } from "./sticky-refresh";

/**
 * The dispatch that decides whether a realtime event re-reads the desktop notes.
 *
 * This replaced `e.type.startsWith("task.")`, which reads like a rule but is an
 * accident of naming: it silently ignored every event outside that prefix,
 * including `sticky.refresh` — the delivery watchdog's entire reason to exist.
 */
describe("shouldRefreshSticky", () => {
  it("refreshes on every task lifecycle event", () => {
    for (const t of [
      "task.assigned",
      "task.acknowledged",
      "task.completed",
      "task.ignored",
      "task.left",
    ]) {
      expect(shouldRefreshSticky(t)).toBe(true);
    }
  });

  it("refreshes on sticky.refresh, which does NOT start with 'task.'", () => {
    // The exact frame the old prefix test dropped on the floor.
    expect(shouldRefreshSticky("sticky.refresh")).toBe(true);
  });

  it("ignores events that cannot change which notes belong on screen", () => {
    for (const t of [
      "message.created",
      "notification.created",
      "call.ring",
      "presence.online",
      "mail.delivered",
    ]) {
      expect(shouldRefreshSticky(t)).toBe(false);
    }
  });

  it("does not match on prefix, so a new task.* event is a deliberate addition", () => {
    // A prefix test would answer true here and quietly re-fetch on an event
    // nobody had considered. An explicit set makes adding one a decision.
    expect(shouldRefreshSticky("task.reviewed")).toBe(false);
    expect(shouldRefreshSticky("task.something.invented.later")).toBe(false);
  });

  it("is not fooled by an empty or malformed type", () => {
    expect(shouldRefreshSticky("")).toBe(false);
    expect(shouldRefreshSticky("task.")).toBe(false);
    expect(shouldRefreshSticky("sticky.")).toBe(false);
  });
});
