import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StickyTaskDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";
import { useDeadlineRefetch } from "./useDeadlineRefetch";

const NOW = new Date("2026-10-01T10:00:00Z");
const task = (id: string, status: StickyTaskDTO["myStatus"], deadlineAt?: string | null) =>
  ({ taskId: id, myStatus: status, deadlineAt }) as StickyTaskDTO;

function setup(tasks: StickyTaskDTO[]) {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  const view = renderHook(({ list }) => useDeadlineRefetch(list), {
    initialProps: { list: tasks },
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  return { spy, ...view };
}
const invalidated = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("re-reading the lists when a deadline passes", () => {
  it("refetches the task lists shortly after the soonest upcoming deadline, once", () => {
    const { spy } = setup([
      task("a", "SENT", "2026-10-01T10:30:00Z"),
      task("b", "ACKNOWLEDGED", "2026-10-01T10:10:00Z"), // soonest
      task("c", "SENT", "2026-10-01T11:00:00Z"),
    ]);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(spy).not.toHaveBeenCalled(); // not at the deadline itself: the sweeper needs a moment
    vi.advanceTimersByTime(4_001);
    const keys = invalidated(spy);
    for (const key of [qk.assigned, qk.sticky, qk.inbox, qk.sent, qk.availability]) expect(keys).toContain(JSON.stringify(key));
    vi.advanceTimersByTime(60 * 60_000);
    expect(spy).toHaveBeenCalledTimes(5); // one timer, not one per task
  });

  it("ignores tasks with no deadline, with a past deadline, or already finished", () => {
    const { spy } = setup([
      task("a", "SENT", null),
      task("b", "SENT", undefined),
      task("c", "SENT", "2026-10-01T09:00:00Z"),
      task("d", "COMPLETED", "2026-10-01T10:10:00Z"),
      task("e", "MISSED", "2026-10-01T10:10:00Z"),
      task("f", "SENT", "garbage"),
    ]);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-arms for the next deadline when the list changes, and never leaves a stale timer", () => {
    const { spy, rerender } = setup([task("a", "SENT", "2026-10-01T10:10:00Z")]);
    rerender({ list: [task("a", "SENT", "2026-10-01T10:20:00Z")] });
    vi.advanceTimersByTime(10 * 60_000 + 5_000);
    expect(spy).not.toHaveBeenCalled(); // the first timer was cleared with the old list
    vi.advanceTimersByTime(10 * 60_000);
    expect(spy).toHaveBeenCalled();
  });

  it("clears its timer when unmounted", () => {
    const { spy, unmount } = setup([task("a", "SENT", "2026-10-01T10:10:00Z")]);
    unmount();
    vi.advanceTimersByTime(60 * 60_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("clamps a far-away deadline instead of firing immediately (setTimeout's 32-bit limit)", () => {
    const { spy } = setup([task("a", "SENT", "2027-10-01T10:00:00Z")]);
    vi.advanceTimersByTime(60_000);
    expect(spy).not.toHaveBeenCalled();
  });
});
