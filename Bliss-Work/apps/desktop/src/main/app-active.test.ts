import { describe, expect, it } from "vitest";
import { isAppActive, shouldFloatNotes, type AppPresence } from "./app-active";

const presence = (over: Partial<AppPresence> = {}): AppPresence => ({
  focused: true,
  minimized: false,
  hidden: false,
  ...over,
});

/**
 * `isAppActive` answers ONE question: is BlissWork the app the user is in.
 *
 * It deliberately does not decide whether a task note is on screen — that is
 * `shouldFloatNotes` below, and conflating the two is precisely how desktop
 * sticking was lost. This module was once wired straight to StickyManager, so
 * "BlissWork is not focused" was read as "hide the notes", which also fires on
 * minimise, on Win+D and on close-to-tray: every one of those is a user looking
 * at their desktop, the exact moment a desktop note is supposed to be there.
 */
describe("isAppActive", () => {
  it("is active when a BlissWork window holds focus", () => {
    expect(isAppActive(presence())).toBe(true);
  });

  it("is inactive when focus has gone to another application", () => {
    expect(isAppActive(presence({ focused: false }))).toBe(false);
  });

  it("is inactive while the main window is minimized, even if it somehow still reports focus", () => {
    expect(isAppActive(presence({ minimized: true }))).toBe(false);
  });

  it("is inactive while the main window is hidden (closed to tray / started at login)", () => {
    expect(isAppActive(presence({ hidden: true }))).toBe(false);
  });

  it("stays active across a focus handoff between two BlissWork windows — `focused` is app-wide", () => {
    // The note itself is focusable:false, so a click on it leaves focus where
    // it was; a chat note taking focus is still a BlissWork window.
    expect(isAppActive(presence({ focused: true }))).toBe(true);
  });
});

/**
 * THE NOTE-VISIBILITY PROMISE.
 *
 * A note is on screen while the user is in BlissWork OR looking at their bare
 * desktop, and is taken away only while some OTHER application is in front.
 * The cases below are the product rule; if one of them has to be changed to
 * make a refactor pass, the refactor has broken the feature.
 */
describe("shouldFloatNotes", () => {
  it("floats while the user is in BlissWork", () => {
    expect(shouldFloatNotes(presence(), false)).toBe(true);
  });

  it("floats while the user is looking at the bare desktop", () => {
    expect(shouldFloatNotes(presence({ focused: false }), true)).toBe(true);
  });

  it("KEEPS FLOATING while BlissWork is minimized and the desktop is showing", () => {
    // The regression: minimising the app took every pinned task off screen.
    expect(shouldFloatNotes(presence({ focused: false, minimized: true }), true)).toBe(true);
  });

  it("KEEPS FLOATING while BlissWork is closed to the tray and the desktop is showing", () => {
    // A note outlives the window it was created from. This is what "the note
    // rests on your desktop" means, and it is the whole point of the feature.
    expect(shouldFloatNotes(presence({ focused: false, hidden: true }), true)).toBe(true);
  });

  it("hides only when another application is in front", () => {
    expect(shouldFloatNotes(presence({ focused: false }), false)).toBe(false);
    expect(shouldFloatNotes(presence({ focused: false, minimized: true }), false)).toBe(false);
    expect(shouldFloatNotes(presence({ focused: false, hidden: true }), false)).toBe(false);
  });

  it("falls back to app focus alone when the desktop reading is unavailable", () => {
    // ./foreground reports false when it cannot answer (no native provider, a
    // Wayland session). That must degrade to "notes follow the app", never to
    // "notes are always up".
    expect(shouldFloatNotes(presence(), false)).toBe(true);
    expect(shouldFloatNotes(presence({ focused: false }), false)).toBe(false);
  });
});
