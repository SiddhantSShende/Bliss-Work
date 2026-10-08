import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkReadWhileViewing } from "./useMarkReadWhileViewing";

let visibility: DocumentVisibilityState;
let focused: boolean;

const msgs = (...seqs: number[]) => seqs.map((seq) => ({ seq }));
const setViewing = (v: { visible?: boolean; focused?: boolean }) =>
  act(() => {
    if (v.visible !== undefined) {
      visibility = v.visible ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    }
    if (v.focused !== undefined) {
      focused = v.focused;
      window.dispatchEvent(new Event(v.focused ? "focus" : "blur"));
    }
  });

beforeEach(() => {
  visibility = "visible";
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => vi.restoreAllMocks());

function mount(initial: { scope: string; messages: { seq: number }[] }) {
  const markRead = vi.fn();
  const view = renderHook((p) => useMarkReadWhileViewing(p.scope, p.messages, markRead), {
    initialProps: initial,
  });
  return { markRead, ...view };
}

describe("useMarkReadWhileViewing", () => {
  it("marks the newest seq read when the thread is open and visible", () => {
    const { markRead } = mount({ scope: "c1", messages: msgs(1, 2, 3) });
    expect(markRead).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("does nothing for an empty thread", () => {
    const { markRead } = mount({ scope: "c1", messages: [] });
    expect(markRead).not.toHaveBeenCalled();
  });

  it("does not mark read while the tab is hidden, then catches up once it is shown", () => {
    visibility = "hidden";
    const { markRead, rerender } = mount({ scope: "c1", messages: msgs(1, 2) });
    rerender({ scope: "c1", messages: msgs(1, 2, 3) });
    expect(markRead).not.toHaveBeenCalled();

    setViewing({ visible: true });
    expect(markRead).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("does not mark read while the window is unfocused", () => {
    focused = false;
    const { markRead } = mount({ scope: "c1", messages: msgs(1, 2) });
    expect(markRead).not.toHaveBeenCalled();
    setViewing({ focused: true });
    expect(markRead).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("stops marking read when focus is lost mid-session", () => {
    const { markRead, rerender } = mount({ scope: "c1", messages: msgs(1, 2) });
    setViewing({ focused: false });
    rerender({ scope: "c1", messages: msgs(1, 2, 3) });
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("does not re-post when an older page is prepended (count changes, newest seq does not)", () => {
    const { markRead, rerender } = mount({ scope: "c1", messages: msgs(21, 22, 23) });
    rerender({ scope: "c1", messages: msgs(1, 2, 3, 21, 22, 23) });
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("posts again for a new message, and for another conversation at the same seq", () => {
    const { markRead, rerender } = mount({ scope: "c1", messages: msgs(1, 2) });
    rerender({ scope: "c1", messages: msgs(1, 2, 3) });
    rerender({ scope: "c2", messages: msgs(1, 2, 3) });
    expect(markRead.mock.calls.map((c) => c[0])).toEqual([2, 3, 3]);
  });
});
