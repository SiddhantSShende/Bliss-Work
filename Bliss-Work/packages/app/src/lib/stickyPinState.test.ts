import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventType, type StickyPinChanged } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { consumeBrowserTaskSelection, useBrowserTaskPinState } from "./browserStickyState";
import { applyStickyPinChanged, isUnpinned, restorePinState, withPinState } from "./stickyPinState";

void useBrowserTaskPinState;

const ME = "33333333-3333-4333-8333-333333333333";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";

function pinEvent(over: Partial<StickyPinChanged> = {}): StickyPinChanged {
  return {
    type: EventType.StickyPinChanged,
    eventId: "e1",
    orgId: "o1",
    occurredAt: "2026-10-01T00:00:00.000Z",
    assigneeId: ME,
    taskId: T1,
    pinState: "UNPINNED",
    ...over,
  };
}

describe("pin state helpers", () => {
  it("withPinState changes only the named task and does not mutate", () => {
    const before = { [T1]: "PINNED", [T2]: "PINNED" } as const;
    const after = withPinState(before, T1, "UNPINNED");
    expect(after).toEqual({ [T1]: "UNPINNED", [T2]: "PINNED" });
    expect(before[T1]).toBe("PINNED");
  });

  it("restorePinState puts back ONE task and leaves every other entry as it now is", () => {
    const now = { [T1]: "UNPINNED", [T2]: "UNPINNED" } as const; // T2 changed after T1's write began
    expect(restorePinState(now, T1, "PINNED")).toEqual({ [T1]: "PINNED", [T2]: "UNPINNED" });
    expect(restorePinState(now, T1, undefined)).toEqual({ [T2]: "UNPINNED" });
    expect(restorePinState(null, T1, "PINNED")).toEqual({ [T1]: "PINNED" });
  });

  it("isUnpinned is true only for an explicit UNPINNED — never for a missing read or task", () => {
    expect(isUnpinned({ [T1]: "UNPINNED" }, T1)).toBe(true);
    expect(isUnpinned({ [T1]: "PINNED" }, T1)).toBe(false);
    expect(isUnpinned({}, T1)).toBe(false);
    expect(isUnpinned(null, T1)).toBe(false);
    expect(isUnpinned(undefined, T1)).toBe(false);
  });
});

describe("applyStickyPinChanged (the realtime event)", () => {
  let qc: QueryClient;
  let invalidate: Mock<(key: readonly unknown[]) => void>;
  const ctx = (over: Partial<{ me: string | undefined; hasDesktopBridge: boolean }> = {}) => ({
    qc,
    invalidate,
    me: ME as string | undefined,
    hasDesktopBridge: false,
    ...over,
  });

  beforeEach(() => {
    qc = new QueryClient();
    invalidate = vi.fn<(key: readonly unknown[]) => void>();
    consumeBrowserTaskSelection();
  });

  it("flips the cached state for that task and leaves the others alone", () => {
    qc.setQueryData(qk.stickyPinStates, { [T1]: "PINNED", [T2]: "PINNED" });

    applyStickyPinChanged(pinEvent({ taskId: T1, pinState: "UNPINNED" }), ctx());

    expect(qc.getQueryData(qk.stickyPinStates)).toEqual({ [T1]: "UNPINNED", [T2]: "PINNED" });
  });

  it("unpin then re-pin from another device ends pinned", () => {
    qc.setQueryData(qk.stickyPinStates, { [T1]: "PINNED" });
    applyStickyPinChanged(pinEvent({ pinState: "UNPINNED" }), ctx());
    applyStickyPinChanged(pinEvent({ pinState: "PINNED" }), ctx());
    expect(qc.getQueryData(qk.stickyPinStates)).toEqual({ [T1]: "PINNED" });
  });

  it("refetches rather than guessing when the pin states were never loaded", () => {
    applyStickyPinChanged(pinEvent(), ctx());

    expect(qc.getQueryData(qk.stickyPinStates)).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith(qk.stickyPinStates);
  });

  it("refetches the sticky list", () => {
    applyStickyPinChanged(pinEvent(), ctx());
    expect(invalidate).toHaveBeenCalledWith(qk.sticky);
  });

  it("a PINNED change on the web brings that note to the front", () => {
    applyStickyPinChanged(pinEvent({ pinState: "PINNED" }), ctx());
    expect(consumeBrowserTaskSelection()).toBe(T1);
  });

  it("an UNPINNED change does not select anything", () => {
    applyStickyPinChanged(pinEvent({ pinState: "UNPINNED" }), ctx());
    expect(consumeBrowserTaskSelection()).toBeNull();
  });

  it("does not drive the browser overlay inside the desktop app", () => {
    applyStickyPinChanged(pinEvent({ pinState: "PINNED" }), ctx({ hasDesktopBridge: true }));
    expect(consumeBrowserTaskSelection()).toBeNull();
  });

  it("ignores another user's event entirely", () => {
    qc.setQueryData(qk.stickyPinStates, { [T1]: "PINNED" });

    applyStickyPinChanged(pinEvent({ assigneeId: "someone-else", pinState: "UNPINNED" }), ctx());

    expect(qc.getQueryData(qk.stickyPinStates)).toEqual({ [T1]: "PINNED" });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
