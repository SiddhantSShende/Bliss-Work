import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUserBehaviorAnalysis } from "./userBehaviorAnalysis";

afterEach(() => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

function hide() {
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
function show() {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
function blur() {
  window.dispatchEvent(new Event("blur"));
}
function focus() {
  window.dispatchEvent(new Event("focus"));
}

describe("visibilitychange", () => {
  it("reports away when the document is hidden", () => {
    const { result } = renderHook(() => useUserBehaviorAnalysis(true));
    act(hide);
    expect(result.current.away).toBe(true);
  });

  it("reports back on return", () => {
    const { result } = renderHook(() => useUserBehaviorAnalysis(true));
    act(hide);
    act(show);
    expect(result.current.away).toBe(false);
  });

  it("calls onAway/onReturn with a 'visibility' source", () => {
    const onAway = vi.fn();
    const onReturn = vi.fn();
    renderHook(() => useUserBehaviorAnalysis(true, { onAway, onReturn }));
    act(hide);
    expect(onAway).toHaveBeenCalledWith(
      expect.objectContaining({ source: "visibility" }),
    );
    act(show);
    expect(onReturn).toHaveBeenCalledWith(
      expect.objectContaining({ source: "visibility" }),
    );
  });
});

describe("window blur/focus — the signal visibilitychange misses on desktop", () => {
  // Electron does not flip document.hidden just because the user switched to
  // a different application while the window stays open and un-minimised —
  // only window blur/focus fire there.
  it("reports away on window blur, with the document itself never reporting hidden", () => {
    const { result } = renderHook(() => useUserBehaviorAnalysis(true));
    act(blur);
    expect(result.current.away).toBe(true);
  });

  it("reports back on window focus", () => {
    const { result } = renderHook(() => useUserBehaviorAnalysis(true));
    act(blur);
    act(focus);
    expect(result.current.away).toBe(false);
  });
});

describe("a real tab switch fires both signals as ONE transition", () => {
  it("fires onAway exactly once even though visibilitychange and blur both fire", () => {
    const onAway = vi.fn();
    const onReturn = vi.fn();
    renderHook(() => useUserBehaviorAnalysis(true, { onAway, onReturn }));

    act(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("blur"));
    });
    expect(onAway).toHaveBeenCalledTimes(1);
    expect(onReturn).not.toHaveBeenCalled();

    act(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});

describe("disabled", () => {
  it("attaches no listeners at all — a hide/blur while disabled is a no-op", () => {
    const onAway = vi.fn();
    renderHook(() => useUserBehaviorAnalysis(false, { onAway }));
    act(hide);
    act(blur);
    expect(onAway).not.toHaveBeenCalled();
  });

  it("drops the away latch when disabled mid-away, so a later re-enable starts clean", () => {
    const onAway = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => useUserBehaviorAnalysis(enabled, { onAway }),
      { initialProps: { enabled: true } },
    );
    act(hide);
    expect(result.current.away).toBe(true);

    rerender({ enabled: false });
    expect(result.current.away).toBe(false);

    rerender({ enabled: true });
    act(hide);
    expect(onAway).toHaveBeenCalledTimes(2); // once per enabled episode, not swallowed
  });
});

describe("cleanup", () => {
  it("removes its listeners on unmount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useUserBehaviorAnalysis(true));
    const visibilityCalls = addSpy.mock.calls.filter((c) => c[0] === "visibilitychange").length;
    unmount();
    const removedCalls = removeSpy.mock.calls.filter((c) => c[0] === "visibilitychange").length;
    expect(removedCalls).toBe(visibilityCalls);
  });
});
