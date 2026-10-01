import { describe, expect, it } from "vitest";
import { incomingCallPopup, popupFor, shouldNotify, windowStateOf } from "./notifier";

/**
 * The content of the native incoming-call toast (Windows Accept/Decline
 * banner) — see incomingCallPopup's own doc in notifier.ts for why the app
 * icon and the actual `new Notification(...)` call (main/index.ts) are
 * deliberately NOT covered here: those touch Electron, this is the pure part.
 */
describe("incomingCallPopup", () => {
  it("shows the caller's name as the title", () => {
    expect(incomingCallPopup("Priya Shah", "video").title).toBe("Priya Shah");
  });

  it("marks a video call distinctly from a voice call", () => {
    expect(incomingCallPopup("Priya Shah", "video").body).toBe("📹 Incoming video call");
    expect(incomingCallPopup("Priya Shah", "audio").body).toBe("📞 Incoming voice call");
  });

  it("carries BlissWork's own branded group header", () => {
    const popup = incomingCallPopup("Priya Shah", "video");
    expect(popup.groupId).toBe("blisswork-calls");
    expect(popup.groupTitle).toBe("BlissWork");
  });

  it("offers Accept then Decline, in that order — main/index.ts's action handler maps them by index", () => {
    const popup = incomingCallPopup("Priya Shah", "video");
    expect(popup.actions).toEqual([
      { type: "button", text: "Accept" },
      { type: "button", text: "Decline" },
    ]);
  });

  it("labels the second action Decline, matching the in-app incoming-call button, not the wire-level 'reject' action name", () => {
    // The IPC action value stays "accept"/"reject" (sendIncomingCallAction in
    // main/index.ts, onIncomingCallAction in callNotify.ts) — only the label
    // shown to the user changes here, to read the same as callRoom.json's
    // callUi.decline.
    expect(incomingCallPopup("Priya Shah", "audio").actions[1]).toEqual({ type: "button", text: "Decline" });
  });
});

describe("message popups", () => {
  it("labels a DM popup from its persisted notification record", () => {
    expect(popupFor({
      type: "notification.created",
      recipientId: "me",
      notificationId: "notification-1",
      kind: "DM_MESSAGE",
      text: "Priya Shah: Hello there",
    }, "me")).toEqual({ notificationId: "notification-1", title: "Priya Shah", body: "Hello there" });
  });

  it("labels a channel popup with the sender and channel from its persisted record", () => {
    expect(popupFor({
      type: "notification.created",
      recipientId: "me",
      notificationId: "notification-2",
      kind: "CHANNEL_MESSAGE",
      text: "Priya Shah in #design-team: Review is ready",
    }, "me")).toEqual({ notificationId: "notification-2", title: "Priya Shah", body: "#design-team: Review is ready" });
  });

  it("ignores records for another recipient and raw message events", () => {
    expect(popupFor({
      type: "notification.created",
      recipientId: "someone-else",
      notificationId: "notification-3",
      kind: "DM_MESSAGE",
      text: "Priya Shah: Hello there",
    }, "me")).toBeNull();
    expect(popupFor({ type: "message.created", senderId: "peer", body: "Hello" }, "me")).toBeNull();
  });
});

describe("channel-added popup", () => {
  const added = {
    type: "notification.created",
    recipientId: "me",
    notificationId: "notification-4",
    kind: "CHANNEL_ADDED",
    text: "Jordan Doe added you to the channel project room",
  };

  it("names who added the user and which channel, from the persisted record", () => {
    expect(popupFor(added, "me")).toEqual({
      notificationId: "notification-4",
      title: "Channel update",
      body: "Jordan Doe added you to the channel project room",
    });
  });

  it("is only for the added user, never another recipient or a signed-out app", () => {
    expect(popupFor({ ...added, recipientId: "jordan" }, "me")).toBeNull();
    expect(popupFor(added, null)).toBeNull();
  });

  it("is not raised a second time from the raw channel.member.joined event", () => {
    expect(popupFor({
      type: "channel.member.joined",
      userId: "me",
      actorId: "jordan",
      channelName: "project room",
    }, "me")).toBeNull();
  });
});

describe("shouldNotify — when an OS popup is allowed", () => {
  const state = { exists: true, visible: true, minimized: false, focused: true };

  it("stays quiet while the window is visible and focused", () => {
    expect(shouldNotify(state)).toBe(false);
  });

  it.each([
    ["unfocused (behind another app)", { ...state, focused: false }],
    ["hidden to the tray", { ...state, visible: false, focused: false }],
    ["minimised", { ...state, minimized: true, focused: false }],
    ["minimised even if the OS still reports focus", { ...state, minimized: true }],
    ["not created yet", { exists: false, visible: false, minimized: false, focused: false }],
  ])("raises a popup when the window is %s", (_name, win) => {
    expect(shouldNotify(win)).toBe(true);
  });
});

describe("windowStateOf", () => {
  it("reads the live window flags", () => {
    const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true };
    expect(windowStateOf(win as never)).toEqual({ exists: true, visible: true, minimized: false, focused: true });
  });

  it("treats a missing or destroyed window as not existing, so a popup is allowed", () => {
    expect(shouldNotify(windowStateOf(null))).toBe(true);
    expect(shouldNotify(windowStateOf({ isDestroyed: () => true } as never))).toBe(true);
  });
});
