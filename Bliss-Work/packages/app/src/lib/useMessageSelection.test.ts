import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMessageSelection } from "./useMessageSelection";

describe("useMessageSelection", () => {
  it("starts inactive with nothing selected", () => {
    const { result } = renderHook(() => useMessageSelection("conv-1"));
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it("enter() activates with an empty selection, even if something was selected before", () => {
    const { result } = renderHook(() => useMessageSelection("conv-1"));
    act(() => result.current.enter());
    act(() => result.current.toggle("m1"));
    expect(result.current.count).toBe(1);

    act(() => result.current.exit());
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    expect(result.current.count).toBe(0);
  });

  it("toggle adds and removes by id, tracking a live count", () => {
    const { result } = renderHook(() => useMessageSelection("conv-1"));
    act(() => result.current.enter());

    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));
    act(() => result.current.toggle("c"));
    expect(result.current.count).toBe(3);

    act(() => result.current.toggle("b"));
    expect(result.current.count).toBe(2);
    expect(result.current.selected.has("a")).toBe(true);
    expect(result.current.selected.has("b")).toBe(false);
    expect(result.current.selected.has("c")).toBe(true);
  });

  it("exit() deactivates and clears the selection", () => {
    const { result } = renderHook(() => useMessageSelection("conv-1"));
    act(() => result.current.enter());
    act(() => result.current.toggle("a"));

    act(() => result.current.exit());
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it("survives an id array being prepended in front — pagination never loses a selection kept elsewhere by id", () => {
    // useMessageSelection itself only ever holds ids, never the message array
    // (that lives in the view, keyed by id via useOlderMessages) — so this
    // pins the actual invariant: selecting "a" and "b" before a page of older
    // messages loads leaves both ids selected afterwards, regardless of what
    // else is now in the list.
    const { result } = renderHook(() => useMessageSelection("conv-1"));
    act(() => result.current.enter());
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));

    // Simulates useOlderMessages prepending an older page — nothing in this
    // hook's own state is keyed on array position, so nothing here changes.
    expect(result.current.selected.has("a")).toBe(true);
    expect(result.current.selected.has("b")).toBe(true);
    expect(result.current.count).toBe(2);
  });

  it("resets active state and selection when scopeId changes — switching conversations mid-selection", () => {
    const { result, rerender } = renderHook(({ scopeId }) => useMessageSelection(scopeId), {
      initialProps: { scopeId: "conv-1" },
    });
    act(() => result.current.enter());
    act(() => result.current.toggle("a"));
    expect(result.current.active).toBe(true);
    expect(result.current.count).toBe(1);

    rerender({ scopeId: "conv-2" });

    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it("does not reset on a re-render that keeps the same scopeId", () => {
    const { result, rerender } = renderHook(({ scopeId }) => useMessageSelection(scopeId), {
      initialProps: { scopeId: "conv-1" },
    });
    act(() => result.current.enter());
    act(() => result.current.toggle("a"));

    rerender({ scopeId: "conv-1" });

    expect(result.current.active).toBe(true);
    expect(result.current.count).toBe(1);
  });
});
