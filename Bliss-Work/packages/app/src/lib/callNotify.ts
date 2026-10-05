/** Desktop notifications for calls.
 *
 *  A ringtone only helps someone who is looking at (or at least listening to)
 *  the tab. The OS notification is the part that reaches a user working in
 *  another window — it raises a banner and plays the system alert sound, and it
 *  is the one alert channel a browser will not silence for lack of a gesture.
 *
 *  Permission is requested on the user's first interaction, never at load:
 *  Chrome refuses a permission prompt without user activation, and an
 *  unprompted one is a bad first impression anyway.
 */
import { loadDesktopNotifs } from "./notificationPrefs";
import i18n from "../i18n";

type Supported = typeof Notification;

type ElectronCallBridge = {
  showIncomingCall: (caller: string, media: "audio" | "video") => void;
  closeIncomingCall: () => void;
  onIncomingCallAction: (cb: (action: "accept" | "reject") => void) => () => void;
};

function electronBridge(): ElectronCallBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { taskboard?: { notifications?: ElectronCallBridge } }).taskboard?.notifications;
}

function api(): Supported | undefined {
  if (typeof window === "undefined") return undefined;
  return "Notification" in window ? window.Notification : undefined;
}

/** Ask once, on the first gesture. Returns an unsubscribe for React cleanup. */
export function primeCallNotifications(): () => void {
  const N = api();
  if (!N || N.permission !== "default") return () => {};
  const events = ["pointerdown", "keydown", "touchstart"] as const;
  const ask = () => {
    off();
    try {
      void N.requestPermission().catch(() => {});
    } catch {
      /* older Safari throws on the promise form — nothing else to try */
    }
  };
  const off = () => events.forEach((e) => window.removeEventListener(e, ask));
  events.forEach((e) => window.addEventListener(e, ask, { once: true, passive: true }));
  return off;
}

export interface CallNotification {
  close: () => void;
}

export function onIncomingCallAction(
  cb: (action: "accept" | "reject") => void,
): () => void {
  return electronBridge()?.onIncomingCallAction(cb) ?? (() => {});
}

/** Raise a notification for an incoming call. Clicking it focuses the app.
 *  Returns a handle whose close() is safe to call more than once. */
export function notifyIncomingCall(caller: string, media: "audio" | "video"): CallNotification {
  const desktop = electronBridge();
  if (desktop) {
    desktop.showIncomingCall(caller, media);
    return { close: desktop.closeIncomingCall };
  }
  const N = api();
  if (!N || N.permission !== "granted" || !loadDesktopNotifs()) return { close: () => {} };
  try {
    const n = new N(i18n.t(`calls:notify.${media === "video" ? "incomingVideo" : "incomingVoice"}`), {
      body: i18n.t("calls:notify.incomingBody", { caller }),
      // Same tag for the whole call so a re-render can never stack banners.
      tag: "blisswork-incoming-call",
      // Keep it on screen: a call is only worth announcing while it rings.
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return { close: () => n.close() };
  } catch {
    return { close: () => {} };
  }
}

/** Raise a notification for a call the user never picked up. */
export function notifyMissedCall(caller: string): void {
  const N = api();
  if (!N || N.permission !== "granted" || !loadDesktopNotifs()) return;
  try {
    const n = new N(i18n.t("calls:notify.missedTitle"), {
      body: i18n.t("calls:notify.missedBody", { caller }),
      tag: "blisswork-missed-call",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* notification refused — the missed call is still in the conversation */
  }
}
