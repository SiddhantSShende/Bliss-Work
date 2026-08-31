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

/** A realtime event as it comes off the wire — untrusted, loosely shaped. */
type WireEvent = Record<string, unknown>;

export interface Popup {
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
  if (!text) return "Sent an attachment";
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
 * Only events a person would want interrupting for are listed. Read receipts,
 * reactions, presence and the rest are traffic, not news.
 */
export function popupFor(event: unknown, meId: string | null): Popup | null {
  if (!event || typeof event !== "object") return null;
  const e = event as WireEvent;
  const str = (k: string): string => (typeof e[k] === "string" ? (e[k] as string) : "");

  switch (e.type) {
    case "message.created": {
      // No `meId` means no session yet (or a signed-out app). Staying silent is
      // the right failure: the alternative is announcing the user's own
      // outgoing messages back at them.
      if (!meId || str("senderId") === meId) return null;
      // MessageCreated carries no sender name — the DM surfaces resolve it from
      // the conversation, which this process has no client for. The preview is
      // what makes the popup actionable anyway.
      return { title: "New message", body: preview(str("body")) };
    }
    case "channel.message.created": {
      if (!meId || str("senderId") === meId) return null;
      // `senderUsername` is the email local-part (see lib/userLabel), so it is
      // the FALLBACK — never the first choice — exactly as in ChannelView.
      const who = str("senderDisplayName") || str("senderUsername");
      return { title: who || "New channel message", body: preview(str("body")) };
    }
    case "task.assigned": {
      // Routed to the assignee alone, so it is always for this user.
      // Deliberately not "New task from <senderUsername>": that field is an
      // email local-part, and "New task from j.okafor" is not a name.
      return { title: "New task", body: str("title") || "You were allocated a task" };
    }
    case "channel.member.joined": {
      // actorId === userId is an open-channel self-join: they clicked Join and
      // do not need telling. An ABSENT actorId is a server older than the
      // field — stay quiet rather than risk announcing someone's own click.
      const actor = str("actorId");
      if (!actor || actor === str("userId")) return null;
      const channel = str("channelName");
      return {
        title: "Added to a channel",
        body: channel ? `You were added to #${channel}` : "You were added to a channel",
      };
    }
    // Mirrors the recipient/actor gate lib/queryBridge applies before it pops
    // the in-app incoming-meeting popup (features/IncomingMeetingNotice), so
    // the two never disagree about whose action this was.
    case "call.started":
    case "call.waiting":
    case "call.ring": {
      if (!meId || str("actorId") === meId) return null;
      const title = str("title") || (str("kind") === "CHANNEL" ? "Channel call" : "Meeting");
      if (e.type === "call.waiting") {
        return { title: "Someone is waiting", body: `Waiting for you to start ${title}` };
      }
      if (e.type === "call.ring") {
        return { title: "Incoming call", body: title };
      }
      return { title: "Meeting started", body: `${title} is starting now` };
    }
    default:
      return null;
  }
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

/** Show one popup. `onClick` should bring the app forward. */
export function raise(popup: Popup, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: popup.title, body: popup.body });
  n.on("click", onClick);
  n.show();
}
