import { describe, expect, it } from "vitest";
import { restoreAction, type WindowState } from "./window-state-guard";

const state = (over: Partial<WindowState> = {}): WindowState => ({
  visible: true,
  minimized: false,
  maximized: false,
  ...over,
});

/**
 * The policy that decides whether a window's state changed because the platform
 * did it, or because the person did.
 *
 * Getting this wrong in the permissive direction is worse than the bug it
 * fixes: a chat app that un-minimises itself, or pops out of the tray, on a
 * machine the user walked away from puts their conversations on a screen they
 * are not in front of.
 */
describe("restoreAction", () => {
  it("undoes a minimise that happened while the machine was away", () => {
    expect(restoreAction(state(), state({ minimized: true }))).toBe("restore");
  });

  it("re-maximises a window the platform restored down", () => {
    expect(restoreAction(state({ maximized: true }), state())).toBe("maximize");
  });

  it("leaves a window the USER minimised before walking away", () => {
    expect(restoreAction(state({ minimized: true }), state({ minimized: true }))).toBe("none");
  });

  it("never summons a window back out of the tray", () => {
    // Closed to the tray before: the user put it away deliberately.
    expect(restoreAction(state({ visible: false }), state({ visible: false }))).toBe("none");
    // And it must not be shown just because it is hidden NOW — the user may
    // have closed it to the tray from another machine's remote session, or the
    // app may have been minimised to tray on lock.
    expect(restoreAction(state(), state({ visible: false }))).toBe("none");
  });

  it("does nothing when nothing changed", () => {
    expect(restoreAction(state(), state())).toBe("none");
    expect(restoreAction(state({ maximized: true }), state({ maximized: true }))).toBe("none");
  });

  it("prefers un-minimising over re-maximising when both changed", () => {
    // restore() on a window that was maximised before it was minimised brings
    // the maximised state back with it, so one action is enough.
    expect(restoreAction(state({ maximized: true }), state({ minimized: true }))).toBe("restore");
  });
});
