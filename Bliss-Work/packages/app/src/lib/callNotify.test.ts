/**
 * Regression coverage for the "Desktop notifications" toggle: it used to write
 * to localStorage and nothing ever read it back, so turning it off had no
 * effect on the popups notifyIncomingCall/notifyMissedCall raise.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { notifyIncomingCall, notifyMissedCall } from "./callNotify";
import { saveDesktopNotifs } from "./notificationPrefs";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {}
  close = vi.fn();
}

beforeEach(() => {
  localStorage.clear();
  FakeNotification.permission = "granted";
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifyIncomingCall", () => {
  it("raises a popup when permission is granted and the preference is on (the default)", () => {
    const ctor = vi.spyOn(globalThis as unknown as { Notification: typeof FakeNotification }, "Notification");
    notifyIncomingCall("Alex", "audio").close();
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the desktop-notifications preference is turned off", () => {
    saveDesktopNotifs(false);
    const ctor = vi.spyOn(globalThis as unknown as { Notification: typeof FakeNotification }, "Notification");
    notifyIncomingCall("Alex", "audio");
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe("notifyMissedCall", () => {
  it("raises a popup when permission is granted and the preference is on (the default)", () => {
    const ctor = vi.spyOn(globalThis as unknown as { Notification: typeof FakeNotification }, "Notification");
    notifyMissedCall("Alex");
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the desktop-notifications preference is turned off", () => {
    saveDesktopNotifs(false);
    const ctor = vi.spyOn(globalThis as unknown as { Notification: typeof FakeNotification }, "Notification");
    notifyMissedCall("Alex");
    expect(ctor).not.toHaveBeenCalled();
  });
});
