/**
 * Collapsing invalidation bursts.
 *
 * The behaviour under test is the reason the app was refetching the same list
 * several times a second on a busy workspace: every inbound message and every
 * read receipt invalidated the conversation list, so a burst of five events
 * cost five identical round trips to reach the state the fifth one described.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QueryKey } from "@tanstack/react-query";
import { createCoalescedInvalidator, INVALIDATE_WINDOW_MS } from "./coalesceInvalidations";

// Typed with the one argument the coalescer actually passes, so `mock.calls`
// carries it and the assertions below need no casts.
function fakeClient() {
  return { invalidateQueries: vi.fn((_filters: { queryKey: QueryKey }) => undefined) };
}
const keysOf = (qc: ReturnType<typeof fakeClient>) =>
  qc.invalidateQueries.mock.calls.map(([filters]) => JSON.stringify(filters.queryKey));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createCoalescedInvalidator", () => {
  it("collapses a burst on one key into a single refetch", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);

    for (let i = 0; i < 5; i++) invalidate(["conversations"]);
    expect(qc.invalidateQueries).not.toHaveBeenCalled(); // nothing yet

    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("still invalidates every DISTINCT key in the burst", () => {
    // Collapsing must not mean dropping: a message touches the conversation
    // list AND the inbox sidebar, and both have to end up refetched.
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);

    invalidate(["conversations"]);
    invalidate(["inboxPeers"]);
    invalidate(["conversations"]);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);

    expect(keysOf(qc).sort()).toEqual(['["conversations"]', '["inboxPeers"]']);
  });

  it("treats structurally equal keys as one", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);
    invalidate(["messages", "abc"]);
    invalidate(["messages", "abc"]);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("keeps keys that only differ in their argument apart", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);
    invalidate(["messages", "abc"]);
    invalidate(["messages", "xyz"]);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-arm the window on each event", () => {
    // The bug this guards: re-arming per event means a steady stream of
    // messages pushes the flush out forever and the list never refreshes.
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc, 100);

    for (let i = 0; i < 10; i++) {
      invalidate(["conversations"]);
      vi.advanceTimersByTime(50); // faster than the window, forever
    }
    expect(qc.invalidateQueries).toHaveBeenCalled();
  });

  it("starts a fresh window for events after a flush", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);

    invalidate(["conversations"]);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
    invalidate(["conversations"]);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);

    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("flush() invalidates immediately for a caller that cannot wait", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);
    invalidate(["conversations"]);
    invalidate.flush();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("flush() on an empty queue does nothing", () => {
    const qc = fakeClient();
    createCoalescedInvalidator(qc).flush();
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it("does not fire again after flush() drained the queue", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);
    invalidate(["conversations"]);
    invalidate.flush();
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS * 2);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops queued work, so a closed socket cannot refetch", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);
    invalidate(["conversations"]);
    invalidate.cancel();
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS * 2);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it("is reusable after cancel()", () => {
    const qc = fakeClient();
    const invalidate = createCoalescedInvalidator(qc);
    invalidate(["a"]);
    invalidate.cancel();
    invalidate(["b"]);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
    expect(keysOf(qc)).toEqual(['["b"]']);
  });

  it("stays well below the round trip it replaces", () => {
    expect(INVALIDATE_WINDOW_MS).toBeLessThan(500);
  });
});
