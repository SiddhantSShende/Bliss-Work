import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { attachToDesktopLayer, type DesktopNative } from "./desktop-layer";

const HWND = 0x1234;

function fakeWindow(visible = true) {
  const handlers = new Map<string, () => void>();
  const win = {
    destroyed: false,
    visible,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    getNativeWindowHandle: () => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(HWND));
      return b;
    },
    on: (event: string, cb: () => void) => void handlers.set(event, cb),
    once: (event: string, cb: () => void) => void handlers.set(event, cb),
    off: (event: string) => void handlers.delete(event),
  };
  return { win, handlers, asWindow: win as unknown as BrowserWindow };
}

function fakeNative(over: Partial<DesktopNative> = {}): DesktopNative & { placeAbove: ReturnType<typeof vi.fn> } {
  return { desktopHost: () => 0xd0, placeAbove: vi.fn(), ...over } as never;
}

/** attachToDesktopLayer resolves its loader asynchronously — let it settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("attachToDesktopLayer", () => {
  it("places the note directly above the desktop window, immediately and on every show", async () => {
    const native = fakeNative();
    const { asWindow, handlers } = fakeWindow();

    attachToDesktopLayer(asWindow, async () => native);
    await settle();
    expect(native.placeAbove).toHaveBeenCalledWith(HWND, 0xd0);

    handlers.get("show")?.();
    expect(native.placeAbove).toHaveBeenCalledTimes(2);
  });

  it("keeps re-asserting so Explorer restarts and Show Desktop cannot bury it", async () => {
    const native = fakeNative();
    const { asWindow } = fakeWindow();

    attachToDesktopLayer(asWindow, async () => native);
    await settle();
    native.placeAbove.mockClear();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(native.placeAbove.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("skips a tick while the desktop window is missing and recovers on the next", async () => {
    let host = 0;
    const native = fakeNative({ desktopHost: () => host });
    const { asWindow } = fakeWindow();

    attachToDesktopLayer(asWindow, async () => native);
    await settle();
    expect(native.placeAbove).not.toHaveBeenCalled();

    host = 0xd1; // Explorer came back with a new desktop window
    await vi.advanceTimersByTimeAsync(2_000);
    expect(native.placeAbove).toHaveBeenCalledWith(HWND, 0xd1);
  });

  it("leaves a hidden or destroyed window alone", async () => {
    const native = fakeNative();
    const hidden = fakeWindow(false);
    const gone = fakeWindow();
    gone.win.destroyed = true;

    attachToDesktopLayer(hidden.asWindow, async () => native);
    attachToDesktopLayer(gone.asWindow, async () => native);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(native.placeAbove).not.toHaveBeenCalled();
  });

  it("falls back to the plain window, without throwing, when the native bridge is unavailable", async () => {
    const { asWindow, handlers } = fakeWindow();

    expect(() => attachToDesktopLayer(asWindow, async () => null)).not.toThrow();
    await settle();

    expect(handlers.size).toBe(0);
  });

  it("gives up after a binding error instead of retrying every tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const native = fakeNative({
      placeAbove: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const { asWindow, handlers } = fakeWindow();

    attachToDesktopLayer(asWindow, async () => native);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(native.placeAbove).toHaveBeenCalledTimes(1);
    expect(handlers.has("show")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("stops the timer when the window closes", async () => {
    const native = fakeNative();
    const { asWindow, handlers } = fakeWindow();

    attachToDesktopLayer(asWindow, async () => native);
    await settle();
    handlers.get("closed")?.();
    native.placeAbove.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(native.placeAbove).not.toHaveBeenCalled();
  });
});
