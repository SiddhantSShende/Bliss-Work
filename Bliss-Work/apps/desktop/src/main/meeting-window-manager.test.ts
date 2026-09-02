import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWindow } from "../test/fake-window";

/**
 * THE ZOMBIE-WINDOW REGRESSION.
 *
 * Electron does not destroy a BrowserWindow when its renderer process
 * crashes (render-process-gone) — the window survives, blank and
 * unresponsive, still reporting !isDestroyed(). Before this fix, has()/
 * get()/open() read only isDestroyed(), so a retried open(callId) — the
 * user clicking Join again after a frozen meeting window — just re-focused
 * the dead window instead of ever recovering the meeting.
 */

const { fakeIpcMain } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    fakeIpcMain: {
      on(event: string, cb: (...a: unknown[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      },
      removeListener(event: string, cb: (...a: unknown[]) => void) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((f) => f !== cb),
        );
      },
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  ipcMain: fakeIpcMain,
}));
vi.mock("./harden", () => ({ hardenWindow: () => {} }));
vi.mock("./assets", () => ({ appIcon: () => undefined }));

import { MeetingWindowManager } from "./meeting-window-manager";

/** Simulate the renderer of `win` crashing, the way Electron would report it. */
function crash(win: FakeWindow): void {
  win.emitWebContents("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
}

describe("MeetingWindowManager — recovering from a crashed meeting window", () => {
  let mgr: MeetingWindowManager;

  beforeEach(() => {
    FakeWindow.reset();
    mgr = new MeetingWindowManager();
  });

  afterEach(() => {
    mgr.destroyAll();
  });

  it("treats a crashed window as gone: has()/get() stop reporting it alive", () => {
    mgr.open("call-1");
    expect(mgr.has("call-1")).toBe(true);

    crash(FakeWindow.all[0]!);

    expect(mgr.has("call-1")).toBe(false);
    expect(mgr.get("call-1")).toBeUndefined();
  });

  it("destroys the crashed window rather than leaving it on screen", () => {
    mgr.open("call-1");
    const win = FakeWindow.all[0]!;
    crash(win);
    expect(win.isDestroyed()).toBe(true);
  });

  it("open() creates a fresh window for the same callId after the old one's renderer crashed", () => {
    mgr.open("call-1");
    const first = FakeWindow.all[0]!;
    crash(first);

    mgr.open("call-1");

    expect(FakeWindow.all).toHaveLength(2);
    const second = FakeWindow.all[1]!;
    expect(second).not.toBe(first);
    expect(mgr.get("call-1")).toBe(second);
    // The dead window must not have been re-focused instead of rebuilt.
    expect(first.called("focus")).toBe(false);
  });

  it("notifies onClosed for the crashed call, the same as an ordinary close", () => {
    const closed: string[] = [];
    mgr.onClosed = (callId) => closed.push(callId);
    mgr.open("call-1");
    crash(FakeWindow.all[0]!);
    expect(closed).toEqual(["call-1"]);
  });

  it("still focuses a live window normally — only a crash forces a rebuild", () => {
    mgr.open("call-1");
    const win = FakeWindow.all[0]!;
    mgr.open("call-1");
    expect(FakeWindow.all).toHaveLength(1);
    expect(win.called("focus")).toBe(true);
  });
});
