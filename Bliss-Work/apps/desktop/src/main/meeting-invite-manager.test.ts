import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWindow, fakeScreen } from "../test/fake-window";
import {
  decideInviteAction,
  MeetingInviteManager,
  type InviteBookkeeping,
} from "./meeting-invite-manager";

// The pure decideInviteAction tests below don't touch Electron at all, but
// MeetingInviteManager itself does (it opens a real BrowserWindow) — same
// mocking pattern as sticky-windows.test.ts / sticky-manager.test.ts.
vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  screen: fakeScreen,
}));
vi.mock("./harden", () => ({ hardenWindow: () => {} }));
vi.mock("./assets", () => ({ appIcon: () => undefined }));

const book = (over: Partial<InviteBookkeeping> = {}): InviteBookkeeping => ({
  current: null,
  announced: new Set(),
  ...over,
});

describe("decideInviteAction", () => {
  it("opens a fresh invite nobody has seen before", () => {
    expect(decideInviteAction(book(), "call-1")).toBe("open");
  });

  it("updates the SAME invite already on screen, instead of opening a second window", () => {
    expect(decideInviteAction(book({ current: "call-1" }), "call-1")).toBe("update");
  });

  it("ignores a callId already shown and since dismissed — the 'one popup, ever' rule", () => {
    // Dismissing clears `current` but NOT `announced` — see the class's own
    // doc comment for why a later event for this same call must not bring
    // the popup back.
    expect(decideInviteAction(book({ current: null, announced: new Set(["call-1"]) }), "call-1")).toBe(
      "ignore",
    );
  });

  it("opens a genuinely different call even while one is already showing", () => {
    expect(decideInviteAction(book({ current: "call-1", announced: new Set(["call-1"]) }), "call-2")).toBe(
      "open",
    );
  });

  it("opens a different call even though some OTHER call was announced before", () => {
    expect(decideInviteAction(book({ announced: new Set(["call-1"]) }), "call-2")).toBe("open");
  });
});

describe("MeetingInviteManager", () => {
  let mgr: MeetingInviteManager;

  beforeEach(() => {
    FakeWindow.reset();
    mgr = new MeetingInviteManager();
  });

  afterEach(() => {
    // Clears the real setTimeout the auto-dismiss timer schedules — nothing
    // here waits 12s for it.
    mgr.destroy();
  });

  /**
   * THE ORGANIZER-NAME RACE.
   *
   * IncomingMeetingNotice.tsx calls showMeetingInvitePopup twice: once
   * immediately with no organizer, then again once the roster resolves it.
   * The second call reaches MeetingInviteManager.show()'s "update" branch,
   * which sends straight over IPC — silently lost forever if the popup's own
   * React app has not mounted and subscribed yet. onRendererReady() is the
   * handshake that closes that gap, mirroring StickyManager's sticky:ready.
   */
  describe("the organizer-name update race", () => {
    it("re-sends the latest invite once the popup's renderer signals it is ready", () => {
      mgr.show({ callId: "call-1", title: "Standup", organizer: "" });
      // The organizer resolves and IncomingMeetingNotice calls show() again —
      // in production this can race ahead of the popup's own React app
      // mounting and subscribing to "meeting-invite:update".
      mgr.show({ callId: "call-1", title: "Standup", organizer: "Jane Okafor" });

      const win = FakeWindow.all[0]!;
      // The popup's renderer finally mounts and asks for the current state.
      mgr.onRendererReady("call-1");

      const sends = win.calls.filter(
        ([n, channel]) => n === "webContents.send" && channel === "meeting-invite:update",
      );
      expect(sends.at(-1)).toEqual([
        "webContents.send",
        "meeting-invite:update",
        { callId: "call-1", title: "Standup", organizer: "Jane Okafor" },
      ]);
    });

    it("still has something to re-send even if ready() is the very first thing that happens", () => {
      // No update() call yet — just the initial open(), whose invite the
      // popup already has from its own URL query string. onRendererReady
      // should still find *something* to push rather than doing nothing.
      mgr.show({ callId: "call-1", title: "Standup", organizer: "" });
      const win = FakeWindow.all[0]!;
      mgr.onRendererReady("call-1");
      expect(
        win.called("webContents.send", "meeting-invite:update", {
          callId: "call-1",
          title: "Standup",
          organizer: "",
        }),
      ).toBe(true);
    });

    it("ignores a ready signal for a callId that is not the one currently showing", () => {
      mgr.show({ callId: "call-1", title: "Standup", organizer: "" });
      const win = FakeWindow.all[0]!;
      const before = win.calls.length;
      mgr.onRendererReady("some-other-call");
      expect(win.calls.length).toBe(before);
    });

    it("does nothing when no popup is open", () => {
      expect(() => mgr.onRendererReady("call-1")).not.toThrow();
    });
  });

  /**
   * SENDER VALIDATION for meeting-invite:act / meeting-invite:ready
   * (main/index.ts) — same pattern as MeetingWindowManager.all() lets
   * meeting-window:status verify its sender.
   */
  describe("currentWindow", () => {
    it("returns undefined when no popup is open", () => {
      expect(mgr.currentWindow()).toBeUndefined();
    });

    it("returns the popup's own window while one is open", () => {
      mgr.show({ callId: "call-1", title: "Standup", organizer: "" });
      expect(mgr.currentWindow()).toBe(FakeWindow.all[0]);
    });

    it("returns undefined again once the popup is dismissed", () => {
      mgr.show({ callId: "call-1", title: "Standup", organizer: "" });
      mgr.dismiss("call-1");
      expect(mgr.currentWindow()).toBeUndefined();
    });
  });
});
