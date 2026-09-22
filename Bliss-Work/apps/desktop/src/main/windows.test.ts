import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The pinned task popup is a persistent desktop widget: on Windows it lives on
 * the desktop layer (never topmost), on macOS/Linux it is an always-on-top
 * overlay. These pin the window's construction — the part that regressed before
 * — on every platform we ship to. What the OS then does with those flags (real
 * stacking against another application) is covered by running the built app.
 */

interface Recorded {
  options: Record<string, unknown>;
  calls: [string, ...unknown[]][];
  handlers: Map<string, () => void>;
}
const h = vi.hoisted(() => ({ last: null as unknown, attach: vi.fn() }));

vi.mock("electron", () => {
  class BrowserWindow {
    rec: Recorded = { options: {}, calls: [], handlers: new Map() };
    webContents = {};
    constructor(options: Record<string, unknown>) {
      this.rec.options = options;
      h.last = this.rec;
    }
    setAlwaysOnTop(...a: unknown[]) {
      this.rec.calls.push(["setAlwaysOnTop", ...a]);
    }
    setVisibleOnAllWorkspaces(...a: unknown[]) {
      this.rec.calls.push(["setVisibleOnAllWorkspaces", ...a]);
    }
    showInactive() {
      this.rec.calls.push(["showInactive"]);
    }
    hide() {
      this.rec.calls.push(["hide"]);
    }
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
    on(event: string, cb: () => void) {
      this.rec.handlers.set(event, cb);
    }
  }
  return {
    BrowserWindow,
    app: { getPath: () => "" },
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: {} }) },
  };
});
vi.mock("./assets", () => ({ appIcon: () => undefined }));
vi.mock("./harden", () => ({ hardenWindow: () => {} }));
vi.mock("./desktop-layer", () => ({ attachToDesktopLayer: h.attach }));
vi.mock("./window-state-guard", () => ({ isSystemAway: () => false }));

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.resetModules();
  h.attach.mockClear();
});

async function createFor(platform: NodeJS.Platform): Promise<Recorded> {
  Object.defineProperty(process, "platform", { value: platform });
  vi.resetModules();
  const { createStickyWindow } = await import("./windows");
  createStickyWindow();
  return h.last as Recorded;
}

describe("pinned popup on Windows", () => {
  it("is NOT topmost — it must never float above other applications", async () => {
    const rec = await createFor("win32");

    expect(rec.options.alwaysOnTop).toBe(false);
    expect(rec.calls.some(([name]) => name === "setAlwaysOnTop")).toBe(false);
  });

  it("is attached to the desktop layer", async () => {
    await createFor("win32");

    expect(h.attach).toHaveBeenCalledTimes(1);
  });
});

describe.each<NodeJS.Platform>(["darwin", "linux"])("pinned popup on %s", (platform) => {
  it("is always-on-top at the highest window level", async () => {
    const rec = await createFor(platform);

    expect(rec.options.alwaysOnTop).toBe(true);
    expect(rec.calls).toContainEqual(["setAlwaysOnTop", true, "screen-saver"]);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("stays visible across workspaces and over fullscreen apps", async () => {
    const rec = await createFor(platform);

    expect(rec.calls).toContainEqual([
      "setVisibleOnAllWorkspaces",
      true,
      { visibleOnFullScreen: true, skipTransformProcessType: true },
    ]);
  });
});

describe.each<NodeJS.Platform>(["win32", "darwin", "linux"])("pinned popup on %s", (platform) => {
  it("is never parked behind other windows by type or owned by another window", async () => {
    const rec = await createFor(platform);

    expect(rec.options).not.toHaveProperty("type"); // no Linux type:"desktop"
    expect(rec.options).not.toHaveProperty("parent");
  });

  it("does not take focus or a taskbar slot", async () => {
    const rec = await createFor(platform);

    expect(rec.options.focusable).toBe(false);
    expect(rec.options.skipTaskbar).toBe(true);
  });

  it("is shown as soon as it is ready, with no foreground-app gating", async () => {
    const rec = await createFor(platform);

    rec.handlers.get("ready-to-show")?.();

    expect(rec.calls).toContainEqual(["showInactive"]);
  });

  it("registers no handler that hides it when focus moves to another app", async () => {
    const rec = await createFor(platform);

    for (const event of ["blur", "hide", "minimize"]) expect(rec.handlers.has(event)).toBe(false);
    expect(rec.calls.some(([name]) => name === "hide")).toBe(false);
  });
});
