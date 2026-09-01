import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWindow, fakeScreen } from "../test/fake-window";

/**
 * WHAT A TASK NOTE ASKS THE OS FOR.
 *
 * The desktop-sticking regression was entirely in this construction: the note
 * was rebuilt as an Electron CHILD of the main window with `alwaysOnTop: false`,
 * which makes it an OWNED window — one that by definition cannot be shown while
 * its owner is minimised or hidden. Pinned tasks therefore vanished on Win+D,
 * on minimise, and on close-to-tray.
 *
 * These assertions are about the product promise, not about Electron trivia.
 * If one of them has to change, the note has stopped resting on the desktop.
 */

let platform: NodeJS.Platform = "win32";

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  screen: fakeScreen,
  app: { getPath: () => "/tmp", isPackaged: false, on: () => {} },
  shell: { openExternal: () => Promise.resolve() },
  globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
  powerMonitor: { on: () => {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));

// Window hardening is a separate concern with its own suite; it would otherwise
// drag screenshot-guard's globalShortcut/powerMonitor wiring into every case.
vi.mock("./harden", () => ({ hardenWindow: () => {} }));
vi.mock("./assets", () => ({ appIcon: () => undefined }));
// The note is created before any float reading exists; "is it safe right now"
// is ./app-active's job and is tested there.
vi.mock("./app-active", () => ({ shouldFloatNotesNow: () => true }));

async function makeNote() {
  vi.resetModules();
  vi.stubGlobal("process", { ...process, platform });
  const { createStickyWindow } = await import("./windows");
  return createStickyWindow("task-1", 0) as unknown as FakeWindow;
}

beforeEach(() => {
  FakeWindow.reset();
  platform = "win32";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a task note is a desktop widget, not a child of the app window", () => {
  it("is NOT owned by another window", async () => {
    // An owned window follows its owner into minimize and hide. That is the
    // single change that made pinned tasks disappear.
    const win = await makeNote();
    expect(win.opts.parent).toBeUndefined();
  });

  it("goes always-on-top on Windows once shown, so it rests above the desktop", async () => {
    // Constructed `false` and raised on ready-to-show, deliberately: the flag
    // is only ever on when the float reading says it is safe, so there is no
    // window of time in which a note is topmost over another application.
    const win = await makeNote();
    expect(win.opts.alwaysOnTop).toBe(false);
    win.emit("ready-to-show");
    expect(win.called("setAlwaysOnTop", true)).toBe(true);
  });

  it("shows itself without taking focus once it is safe to float", async () => {
    const win = await makeNote();
    win.emit("ready-to-show");
    expect(win.called("showInactive")).toBe(true);
    expect(win.called("show")).toBe(false);
    expect(win.called("setAlwaysOnTop", true)).toBe(true);
  });

  it("never steals focus or appears in the taskbar", async () => {
    const win = await makeNote();
    expect(win.opts.focusable).toBe(false);
    expect(win.opts.skipTaskbar).toBe(true);
  });

  it("cannot be minimized, because it has no taskbar button to come back from", async () => {
    const win = await makeNote();
    expect(win.opts.minimizable).toBe(false);
  });
});

describe("per-platform desktop mechanism", () => {
  it("on Linux sits on the wallpaper layer instead of always-on-top", async () => {
    // _NET_WM_WINDOW_TYPE_DESKTOP parks the window at the bottom of the stack:
    // literally on the desktop, and never over anyone's work — so there is
    // nothing to raise and nothing to hide.
    platform = "linux";
    const win = await makeNote();
    expect(win.opts.type).toBe("desktop");
  });

  it("uses always-on-top, not the wallpaper layer, on Windows and macOS", async () => {
    for (const p of ["win32", "darwin"] as NodeJS.Platform[]) {
      platform = p;
      FakeWindow.reset();
      const win = await makeNote();
      expect(win.opts.type).toBeUndefined();
      win.emit("ready-to-show");
      expect(win.called("setAlwaysOnTop", true)).toBe(true);
    }
  });
});

describe("setNoteOnTop", () => {
  it("raises and drops the flag on Windows and macOS", async () => {
    platform = "win32";
    vi.resetModules();
    vi.stubGlobal("process", { ...process, platform });
    const { setNoteOnTop } = await import("./windows");
    const win = new FakeWindow();
    setNoteOnTop(win as never, true);
    setNoteOnTop(win as never, false);
    expect(win.called("setAlwaysOnTop", true)).toBe(true);
    expect(win.called("setAlwaysOnTop", false)).toBe(true);
  });

  it("is a no-op on Linux, where raising would lift the note off the wallpaper", async () => {
    platform = "linux";
    vi.resetModules();
    vi.stubGlobal("process", { ...process, platform });
    const { setNoteOnTop } = await import("./windows");
    const win = new FakeWindow();
    setNoteOnTop(win as never, true);
    expect(win.calls).toHaveLength(0);
  });
});
