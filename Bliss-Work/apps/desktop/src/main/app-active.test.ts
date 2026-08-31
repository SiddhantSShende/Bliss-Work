import { describe, expect, it } from "vitest";
import { isAppActive, type AppPresence } from "./app-active";

const presence = (over: Partial<AppPresence> = {}): AppPresence => ({
  focused: true,
  minimized: false,
  hidden: false,
  ...over,
});

/**
 * The policy that decides whether the floating task notes are on screen.
 *
 * Getting this wrong in the permissive direction is the bug this replaces: a
 * note left on screen while the user is in another application covers work
 * that is not ours to cover. So every "not clearly BlissWork" case must answer
 * false, and only an unambiguously focused, on-screen BlissWork answers true.
 */
describe("isAppActive", () => {
  it("is active when a BlissWork window holds focus", () => {
    expect(isAppActive(presence())).toBe(true);
  });

  it("is INACTIVE when focus has gone to another application", () => {
    expect(isAppActive(presence({ focused: false }))).toBe(false);
  });

  it("is INACTIVE while the main window is minimized, even if it somehow still reports focus", () => {
    expect(isAppActive(presence({ minimized: true }))).toBe(false);
  });

  it("is INACTIVE while the main window is hidden (closed to tray / started at login)", () => {
    expect(isAppActive(presence({ hidden: true }))).toBe(false);
  });

  it("is INACTIVE before a main window exists at all", () => {
    // trackMainWindow(null) — nothing to be a companion to yet.
    expect(isAppActive(presence({ hidden: true, focused: false }))).toBe(false);
  });

  it("stays active across a focus handoff between two BlissWork windows — `focused` is app-wide, not per-window", () => {
    // The note itself is focusable:false, so a click on it leaves focus where
    // it was; a chat note taking focus is still a BlissWork window. Either way
    // the app-wide read is true and the notes stay up.
    expect(isAppActive(presence({ focused: true }))).toBe(true);
  });
});
