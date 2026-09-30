import { describe, expect, it } from "vitest";
import { incomingCallPopup, popupFor } from "./notifier";

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
