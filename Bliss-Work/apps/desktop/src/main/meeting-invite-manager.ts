import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const preloadMeetingInvite = join(here, "../preload/meeting-invite.js");
const rendererDir = join(here, "../renderer");

const WIDTH = 280;
const HEIGHT = 230;
const SCREEN_PAD = 16;

/** Mirrors IncomingMeetingNotice's own AUTO_DISMISS_MS (features/
 *  IncomingMeetingNotice.tsx) so desktop and web behave identically: an
 *  invite nobody answers stops interrupting after the same window either
 *  way. */
const AUTO_DISMISS_MS = 12_000;

export interface MeetingInvite {
  callId: string;
  title: string;
  organizer: string;
  /** An ad-hoc call (a 1:1 growing into, or already, a conference) — not a
   *  Meeting. Lets the popup's OS-level window title say "call" rather than
   *  "meeting", a separate string from the body text `title` already covers. */
  adhoc?: boolean;
}

/** What the manager's own bookkeeping looks like as plain data — the same
 *  "convert Electron state to plain data first" split notifier.ts uses
 *  between windowStateOf() and the pure shouldNotify(). `current` is null
 *  both when nothing is showing AND when the window that was showing it has
 *  since crashed/closed, so callers derive it from a live isDestroyed()
 *  check rather than from bookkeeping alone. */
export interface InviteBookkeeping {
  current: string | null;
  announced: ReadonlySet<string>;
}

export type InviteAction = "open" | "update" | "ignore";

/**
 * Pure decision for `show()`: given what is already on screen and what has
 * ever been announced, what should a newly-arrived invite for `callId` do?
 * No Electron calls in here — see MeetingInviteManager.show() for the few
 * lines that act on the answer. Split out purely for testability, matching
 * notifier.ts's popupFor/shouldNotify split.
 */
export function decideInviteAction(book: InviteBookkeeping, callId: string): InviteAction {
  if (book.current === callId) return "update";
  if (book.announced.has(callId)) return "ignore";
  return "open";
}

/**
 * The always-on-top meeting-invite popup — the desktop-level counterpart of
 * IncomingMeetingNotice (packages/app/src/features/IncomingMeetingNotice.tsx),
 * for when BlissWork's own window is not what the user is looking at.
 *
 * ── Real always-on-top, unlike sticky notes ─────────────────────────────────
 * Sticky notes (./windows.ts's createStickyWindow) are deliberately NEVER
 * alwaysOnTop and are OWNED by the main window, specifically so they can
 * never rise above another application — a new task can wait. A meeting
 * invite is the opposite kind of interruption, the same class as an
 * incoming phone call, so this window is built the other way: a real
 * OS-level alwaysOnTop window, shown regardless of whether BlissWork's own
 * window is focused, visible, or even open at all — the ws-process that
 * feeds it (see main/index.ts) keeps running in the tray the whole time the
 * app is running, main window or not.
 *
 * ── One popup per meeting, ever ──────────────────────────────────────────────
 * `announced` never shrinks for the life of the process: once a callId has
 * been shown, it is never shown again, no matter how many more
 * call.started/call.waiting/call.ring events arrive for it. That is the
 * desktop half of "exactly one popup per invite" — see
 * IncomingMeetingNotice.tsx's own `seenRef` for the identical rule on web,
 * and its own doc comment for why "while currently showing" alone is not
 * enough (a later event for an already-dismissed call must not bring the
 * popup back).
 *
 * A SECOND, different invite arriving while one is already on screen
 * replaces it (closes the old window, opens a new one) rather than
 * stacking — matching IncomingMeetingNotice's single-slot behaviour on web.
 */
export class MeetingInviteManager {
  private win: BrowserWindow | null = null;
  private current: string | null = null;
  private announced = new Set<string>();
  private dismissTimer: NodeJS.Timeout | null = null;
  /** The invite last shown for `current`, kept so onRendererReady() can
   *  re-push it — see that method's own doc comment. */
  private latestInvite: MeetingInvite | null = null;

  /**
   * A meeting invite arrived (or its details were refreshed — see
   * IncomingMeetingNotice's two-phase call: title immediately, organizer once
   * resolved). Opens the popup for a genuinely new callId; for the SAME
   * callId already on screen, just pushes the fresh title/organizer to the
   * existing window instead of reopening it. Silently does nothing for a
   * callId already shown (and possibly since dismissed) — see the class doc.
   */
  show(invite: MeetingInvite): void {
    const windowAlive = this.win !== null && !this.win.isDestroyed();
    const action = decideInviteAction(
      { current: windowAlive ? this.current : null, announced: this.announced },
      invite.callId,
    );
    if (action === "ignore") return;
    if (action === "update") {
      this.latestInvite = invite;
      this.win!.webContents.send("meeting-invite:update", invite);
      return;
    }
    this.announced.add(invite.callId);
    this.open(invite);
  }

  /** The invite's own Video/Voice/Leave was acted on, or its auto-dismiss
   *  timer fired — either way there is nothing left to show for this call.
   *  A no-op if `callId` is not the one currently open (a stale timer from an
   *  invite already replaced by a newer one). */
  dismiss(callId: string): void {
    if (this.current !== callId) return;
    this.closeCurrent();
  }

  /**
   * The popup's own renderer (renderer/meeting-invite.tsx) has registered its
   * "meeting-invite:update" listener and is ready. Re-push the latest invite
   * so an update sent BEFORE that listener existed — the organizer resolving
   * between IncomingMeetingNotice's two show() calls is the common case — is
   * not lost for good. Same handshake as StickyManager.onRendererReady /
   * "sticky:ready"; unlike a task note, this window's FIRST paint already
   * comes from the URL query string it was opened with (see open() below), so
   * this only ever needs to cover the update path, not the initial one.
   *
   * A no-op if `callId` is not the invite currently open (a stale ready from
   * a popup already replaced or dismissed).
   */
  onRendererReady(callId: string): void {
    if (this.current !== callId) return;
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.latestInvite || this.latestInvite.callId !== callId) return;
    this.win.webContents.send("meeting-invite:update", this.latestInvite);
  }

  /** The invite popup's own BrowserWindow right now, or undefined when none
   *  is open — lets main/index.ts verify an inbound meeting-invite:act/
   *  meeting-invite:ready IPC actually came from the popup this manager owns,
   *  the same way MeetingWindowManager.all() lets meeting-window:status
   *  verify ITS sender. */
  currentWindow(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined;
  }

  private open(invite: MeetingInvite): void {
    this.closeCurrent();
    this.current = invite.callId;
    this.latestInvite = invite;

    // Same construction pattern as createStickyWindow (./windows.ts) — opaque
    // rather than transparent (see that file's own comment on why a
    // non-compositing Linux WM makes `transparent: true` paint a wrong-
    // coloured block instead of a see-through window) — except alwaysOnTop
    // and focusable are the OPPOSITE of a sticky note's, and there is no
    // `parent` at all: this window's whole point is to sit above every
    // application, not just above BlissWork's own.
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      resizable: false,
      movable: true,
      frame: false,
      transparent: false,
      backgroundColor: "#ffffff",
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true, // unlike a sticky note — the three buttons take real clicks
      hasShadow: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      icon: appIcon(),
      webPreferences: {
        preload: preloadMeetingInvite,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    // "screen-saver" level on macOS/Linux (Electron's highest tier below an
    // actual screensaver) is what makes this rise above a full-screened other
    // app, not just an ordinary windowed one — an incoming call is exactly
    // the kind of interruption that level exists for.
    win.setAlwaysOnTop(true, "screen-saver");

    hardenWindow(win, "meeting-invite");
    this.position(win);

    const query =
      `?callId=${encodeURIComponent(invite.callId)}` +
      `&title=${encodeURIComponent(invite.title)}` +
      `&organizer=${encodeURIComponent(invite.organizer)}` +
      `&adhoc=${invite.adhoc ? "1" : "0"}`;
    if (DEV_URL) void win.loadURL(`${DEV_URL}/meeting-invite.html${query}`);
    else void win.loadFile(join(rendererDir, "meeting-invite.html"), { search: query });

    // showInactive, not show: an invite that grabs OS-level keyboard focus
    // the instant it appears would yank the cursor out from under whatever
    // the user is typing elsewhere. alwaysOnTop already makes it impossible
    // to miss; it does not also need to steal focus to be seen, and the
    // window is `focusable: true` so a click on it still works normally.
    win.on("ready-to-show", () => win.showInactive());

    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.current = null;
        this.latestInvite = null;
      }
    });

    this.win = win;
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => this.dismiss(invite.callId), AUTO_DISMISS_MS);
  }

  /** Bottom-right of the primary display, matching where the web/in-page
   *  popup (IncomingMeetingNotice) sits — one consistent corner regardless of
   *  which platform is actually showing the invite. */
  private position(win: BrowserWindow): void {
    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - WIDTH - SCREEN_PAD;
    const y = workArea.y + workArea.height - HEIGHT - SCREEN_PAD;
    win.setPosition(Math.max(workArea.x + SCREEN_PAD, x), Math.max(workArea.y + SCREEN_PAD, y));
  }

  private closeCurrent(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
    this.current = null;
    this.latestInvite = null;
  }

  /** Quit teardown — same shape as StickyManager.destroyAll(). */
  destroy(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.current = null;
    this.latestInvite = null;
  }
}
