import { describe, expect, it } from "vitest";
import { isSafeToFloat } from "./foreground";

/**
 * isSafeToFloat — the single function every platform assumption in the
 * "pin to window" feature lives in. Covers the behavioural fix directly: a
 * task note must float above BlissWork's OWN windows (any window owned by
 * this process, not just the literal bare desktop) and must never be
 * considered safe while a genuinely different application is frontmost.
 */
describe("isSafeToFloat", () => {
  it("is safe when the frontmost window belongs to this very process, on every platform — this is the fix: BlissWork's own windows, not just the bare desktop", () => {
    const ownWindow = { title: "BlissWork", owner: { name: "BlissWork", processId: process.pid } };
    expect(isSafeToFloat(ownWindow, "win32")).toBe(true);
    expect(isSafeToFloat(ownWindow, "darwin")).toBe(true);
  });

  it("is NOT safe when a different application's window is frontmost", () => {
    expect(isSafeToFloat({ title: "Visual Studio Code", owner: { processId: 999999 } }, "win32")).toBe(false);
  });

  describe("win32 — bare desktop (Progman)", () => {
    it("is safe when Program Manager is frontmost", () => {
      expect(isSafeToFloat({ title: "Program Manager", owner: { processId: 42 } }, "win32")).toBe(true);
    });

    it("is NOT safe for a File Explorer window, even though it's the same process as the desktop", () => {
      expect(isSafeToFloat({ title: "Documents", owner: { name: "explorer.exe", processId: 42 } }, "win32")).toBe(
        false,
      );
    });
  });

  describe("darwin — bare desktop (untitled Finder)", () => {
    it("is safe when Finder is frontmost with no titled window", () => {
      expect(isSafeToFloat({ owner: { name: "Finder", processId: 42 } }, "darwin")).toBe(true);
    });

    it("is NOT safe for a real Finder window (a folder open, i.e. titled)", () => {
      expect(isSafeToFloat({ title: "Downloads", owner: { name: "Finder", processId: 42 } }, "darwin")).toBe(false);
    });

    it("is NOT safe for a different app entirely", () => {
      expect(isSafeToFloat({ title: "index.ts", owner: { name: "Code", processId: 42 } }, "darwin")).toBe(false);
    });
  });

  describe("linux", () => {
    it("is always safe — the note sits at the bottom of the real window stack instead", () => {
      expect(isSafeToFloat(undefined, "linux")).toBe(true);
      expect(isSafeToFloat({ title: "Anything", owner: { processId: 42 } }, "linux")).toBe(true);
    });
  });

  it("is not safe when nothing is reported (undefined active window) on win32/darwin", () => {
    expect(isSafeToFloat(undefined, "win32")).toBe(false);
    expect(isSafeToFloat(undefined, "darwin")).toBe(false);
  });
});
