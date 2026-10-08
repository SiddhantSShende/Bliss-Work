/**
 * OS notification popups for realtime events.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * The ws-process holds the WebSocket independently of any window, so events keep
 * arriving while the main window is hidden in the tray or minimised. Until now
 * every one of them was forwarded to the renderer and nowhere else — and a
 * hidden renderer's `sonner` toast is drawn inside a window nobody can see. A
 * user who closed the window was, in practice, unreachable: they found out
 * about a message the next time they opened the app.
 *
 * ── Why this must NOT fire when the app is in front of you ───────────────────
 * The in-app toast and the bell already cover that case, and an OS popup on top
 * of them is the same information twice — once in a panel that steals focus.
 * `shouldNotify` is the whole rule and it is deliberately one expression: if the
 * window exists, is visible, is not minimised and has focus, the user is
 * already looking at the app and gets nothing here.
 *
 * ── Split for testability ────────────────────────────────────────────────────
 * `popupFor` and `shouldNotify` are pure and hold every decision worth being
 * wrong about; `raise` is the three lines that touch Electron. Same shape as
 * screenshot-guard.ts.
 */
import { Notification, type BrowserWindow } from "electron";
import { readablePrefix } from "@taskboard/app/chatEnvelope";
import { notificationRoute } from "@taskboard/app/lib/notificationDestination";
import type { NotificationDTO } from "@taskboard/shared";
import { mainT } from "./i18n";

/** A realtime event as it comes off the wire — untrusted, loosely shaped. */
type WireEvent = Record<string, unknown>;

export interface Popup {
  notificationId: string;
  title: string;
  body: string;
}

/** What `shouldNotify` needs to know about the main window. */
export interface WindowState {
  exists: boolean;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

/**
 * OS popups are for when the app is NOT in front of the user: closed to the
 * tray, minimised, or sitting behind whatever they are actually working in.
 * With the window visible and focused they are reading the app itself, and the
 * event is already on screen.
 */
export function shouldNotify(win: WindowState): boolean {
  return !(win.exists && win.visible && !win.minimized && win.focused);
}

export function windowStateOf(win: BrowserWindow | null): WindowState {
  if (!win || win.isDestroyed()) {
    return { exists: false, visible: false, minimized: false, focused: false };
  }
  return {
    exists: true,
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
  };
}

/** Longest body we put in a popup. Every OS truncates; this makes it ours. */
const MAX_BODY = 180;

/**
 * The readable half of a message body.
 *
 * Message bodies can carry a structured attachment envelope after a sentinel
 * byte. Printing one verbatim puts raw JSON in a desktop notification, so this
 * goes through the same `readablePrefix` the app and the pinned-chat window
 * use — one definition of "what this message says", not three.
 */
function preview(body: string): string {
  const text = readablePrefix(body);
  if (!text) return mainT("notifications.attachment");
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1).trimEnd()}…` : text;
}

/**
 * The popup for one realtime event, or null when it does not deserve one.
 *
 * `meId` is the signed-in user id. It is load-bearing rather than defensive:
 * the gateway routes a DM to BOTH parties so the sender's other devices stay in
 * sync, so without it the app would pop a notification for every message the
 * user themselves sent.
 *
 * Only persisted notification.created records are eligible. The bell and the
 * native popup therefore name the same server-owned row instead of each
 * independently turning the underlying message event into an alert.
 */
export function popupFor(event: unknown, meId: string | null): Popup | null {
  if (!event || typeof event !== "object") return null;
  const e = event as WireEvent;
  const str = (k: string): string => (typeof e[k] === "string" ? (e[k] as string) : "");

  switch (e.type) {
    case "notification.created": {
      if (!meId || str("recipientId") !== meId) return null;
      const notificationId = str("notificationId");
      const kind = str("kind");
      const text = str("text");
      if (!notificationId || !text) return null;

      if (kind === "DM_MESSAGE") {
        const split = text.indexOf(": ");
        return split > 0
          ? { notificationId, title: text.slice(0, split), body: preview(text.slice(split + 2)) }
          : { notificationId, title: mainT("notifications.newMessage"), body: preview(text) };
      }
      if (kind === "CHANNEL_MESSAGE") {
        const split = text.indexOf(": ");
        if (split > 0) {
          const attribution = text.slice(0, split);
          const channelMarker = attribution.indexOf(" in #");
          return {
            notificationId,
            title: channelMarker > 0 ? attribution.slice(0, channelMarker) : attribution,
            body: `${channelMarker > 0 ? `#${attribution.slice(channelMarker + 5)}: ` : ""}${preview(text.slice(split + 2))}`,
          };
        }
      }
      const title = kind.startsWith("TASK_")
        ? mainT("notifications.taskUpdate")
        : kind.startsWith("MEETING_")
          ? mainT("notifications.meeting")
        : kind.startsWith("CHANNEL_")
          ? mainT("notifications.channelUpdate")
          : mainT("notifications.brand");
      return { notificationId, title, body: preview(text) };
    }
    // call.started / call.waiting / call.ring deliberately have NO case here.
    // They already get their own dedicated, always-on-top popup window (see
    // main/meeting-invite-manager.ts, driven by IncomingMeetingNotice on the
    // renderer side) regardless of whether this window is focused — routing
    // them through this generic OS-Notification path too was the exact
    // duplicate-popup bug: both would fire for the same event whenever the
    // main window was visible-but-unfocused.
    default:
      return null;
  }
}

/**
 * The in-app route a popup should open when clicked, or null when there is none.
 *
 * Built from the persisted record's own kind and ids (message id included) by the
 * same function the bell uses — never from its text — and checked against the
 * route allowlist, so what main hands the renderer is something the app could have
 * produced itself. An unknown kind has no target: clicking brings the app forward
 * and marks it read, rather than moving the user off the page they were on.
 */
export function notificationPathFor(event: unknown, meId: string | null): string | null {
  if (!event || typeof event !== "object" || !meId) return null;
  const e = event as WireEvent;
  const str = (k: string): string | null => (typeof e[k] === "string" ? (e[k] as string) : null);
  if (e.type !== "notification.created" || str("recipientId") !== meId) return null;
  return notificationRoute({
    kind: str("kind") as NotificationDTO["kind"],
    taskId: str("taskId"),
    channelId: str("channelId"),
    conversationId: str("conversationId"),
    messageId: str("messageId"),
    callId: str("callId"),
  });
}

/**
 * The signed-in user id, read from the access token's `sub` claim.
 *
 * NOT authentication and never used as such: the signature is not checked and
 * the claims are not trusted for anything. The only question being asked is
 * "did I send this message myself", and the worst case of a wrong answer is a
 * missing or a duplicated popup. Every real authorization decision is made
 * server-side against a verified token.
 */
export function userIdFromToken(token: string | null): string | null {
  if (!token) return null;
  const [, claims] = token.split(".");
  if (!claims) return null;
  try {
    const json = Buffer.from(claims, "base64url").toString("utf8");
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    // A token we cannot read is a token we do not use. Popups degrade; nothing
    // else depends on this.
    return null;
  }
}

/**
 * Popups that are on screen (or waiting in the OS notification centre). Electron
 * does not keep a Notification alive once its last reference is dropped, and on
 * Windows/macOS a garbage-collected one never fires `click` — the popup is still
 * visible but clicking it does nothing. So each one is held here until the OS
 * reports it is over.
 */
const livePopups = new Set<Notification>();

/** How many raised popups are still held (for tests). */
export function livePopupCount(): number {
  return livePopups.size;
}

/** Show one popup. `onClick` should bring the app forward. */
export function raise(popup: Popup, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: popup.title, body: popup.body });
  livePopups.add(n);
  const release = () => {
    livePopups.delete(n);
  };
  n.on("click", () => {
    release();
    onClick();
  });
  n.on("close", release);
  n.on("failed", release);
  n.show();
}

export interface IncomingCallPopup {
  title: string;
  body: string;
  /** Windows only: both must be set together for the OS to draw a header
   *  above the toast (see NotificationConstructorOptions.groupTitle) — the
   *  one piece of native chrome this toast can carry actual BlissWork
   *  branding in, short of a custom toastXml template. */
  groupId: string;
  groupTitle: string;
  actions: { type: "button"; text: string }[];
}

/**
 * The content for a ringing 1:1 call's native toast — everything worth
 * getting right and testing about it, as distinct from the three lines in
 * main/index.ts that actually touch `Notification` (the app icon included:
 * that comes from assets.ts's `appIcon()`, a `NativeImage`, which is a
 * different kind of thing to unit-test than the plain data this returns; see
 * `raise` above for the same split on the generic-event popup).
 *
 * The plain, default (non-toastXml) Windows toast has exactly one image slot
 * — already spent here on the BlissWork mark — so a second, per-caller
 * avatar image is a genuine native-notification limitation, not an oversight:
 * showing one would mean either replacing the branding image with it (a
 * worse trade) or hand-building the toast's full XML, which would also have
 * to reimplement the `action` event's index-based accept/reject wiring
 * in main/index.ts that this is deliberately not disturbing. The caller's
 * name carries their identity instead, exactly as it does today.
 *
 * "Decline" (not "Reject") to read the same as the in-app incoming-call
 * button (callRoom.json's callUi.decline) — the two are the same action on
 * two different surfaces, and calling it something else here is the kind of
 * needless inconsistency a viewer should not have to notice.
 */
export function incomingCallPopup(caller: string, media: "audio" | "video"): IncomingCallPopup {
  return {
    title: caller,
    // A leading glyph is the one call/video indicator a plain-text Windows
    // toast body can carry without a custom template — Windows 10/11 render
    // emoji in notification text natively, no image asset required.
    body: media === "video" ? mainT("notifications.incomingVideoCall") : mainT("notifications.incomingVoiceCall"),
    groupId: "blisswork-calls",
    groupTitle: mainT("notifications.brand"),
    actions: [
      { type: "button", text: mainT("notifications.accept") },
      { type: "button", text: mainT("notifications.decline") },
    ],
  };
}
