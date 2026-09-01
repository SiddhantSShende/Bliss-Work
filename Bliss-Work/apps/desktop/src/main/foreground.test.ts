import { describe, expect, it } from "vitest";
import { isSafeToFloat, type ForegroundWindow } from "./foreground";

/**
 * THE DESKTOP-STICKING REGRESSION TEST.
 *
 * A task note is a desktop widget: it rests on the user's desktop and is there
 * whenever they can see it. This predicate is the half of that promise Electron
 * cannot answer — "is the thing in front of me the bare desktop, or somebody
 * else's application?" — and deleting it is how the feature was lost once
 * already. Every case below is a statement about the product, not about
 * `get-windows`.
 *
 * The other half (BlissWork's own focus) lives in ./app-active, and
 * `shouldFloatNotes` there is what ORs the two together.
 */

const win = (over: Partial<ForegroundWindow> = {}): ForegroundWindow => ({
  title: "Some Window",
  owner: { name: "Some App", processId: 4242 },
  ...over,
});

describe("isSafeToFloat", () => {
  it("is safe when the frontmost window is one of BlissWork's own, on every platform", () => {
    const ours = win({ owner: { name: "BlissWork", processId: process.pid } });
    for (const p of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
      expect(isSafeToFloat(ours, p)).toBe(true);
    }
  });

  it("is NOT safe when a different application's window is frontmost", () => {
    expect(isSafeToFloat(win(), "win32")).toBe(false);
    expect(isSafeToFloat(win(), "darwin")).toBe(false);
  });

  describe("win32 — the bare desktop is Program Manager", () => {
    it("is safe when Program Manager is frontmost (desktop clicked, or Win+D)", () => {
      expect(isSafeToFloat(win({ title: "Program Manager" }), "win32")).toBe(true);
    });

    it("is NOT safe for a File Explorer window, which is the same process as the desktop", () => {
      // Matched on the title, not on explorer.exe: a file browser is another
      // application to stay out of the way of, and it shares Progman's process.
      expect(isSafeToFloat(win({ title: "Downloads" }), "win32")).toBe(false);
    });
  });

  describe("darwin — the bare desktop is an untitled Finder", () => {
    it("is safe when Finder is frontmost with no titled window", () => {
      expect(
        isSafeToFloat({ owner: { name: "Finder", processId: 9 } }, "darwin"),
      ).toBe(true);
    });

    it("is NOT safe for a real Finder window (a folder open, i.e. titled)", () => {
      expect(
        isSafeToFloat({ title: "Documents", owner: { name: "Finder", processId: 9 } }, "darwin"),
      ).toBe(false);
    });
  });

  describe("linux", () => {
    it("is always safe — the note sits on the wallpaper layer instead", () => {
      // createStickyWindow gives Linux notes `type: "desktop"`, which parks them
      // at the BOTTOM of the stack. They can never be over anyone's work, so
      // there is nothing for this reading to take away.
      expect(isSafeToFloat(win(), "linux")).toBe(true);
      expect(isSafeToFloat(undefined, "linux")).toBe(true);
    });
  });

  it("FAILS CLOSED when the OS reports nothing at all", () => {
    // This is the inversion that makes the reading safe to have back. The
    // original version defaulted to "safe" whenever it could not answer, which
    // left notes always-on-top over other applications — the one thing the
    // feature promises never to do. Unknown must mean "not the desktop"; the
    // cost is only that a note waits for BlissWork's own focus.
    expect(isSafeToFloat(undefined, "win32")).toBe(false);
    expect(isSafeToFloat(undefined, "darwin")).toBe(false);
    expect(isSafeToFloat({}, "win32")).toBe(false);
    expect(isSafeToFloat({ owner: {} }, "darwin")).toBe(false);
  });
});
