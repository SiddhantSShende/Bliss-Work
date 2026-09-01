import { app, BrowserWindow } from "electron";
import {
  isDesktopShowingNow,
  onDesktopShowingChange,
  pokeDesktopWatch,
  startDesktopWatch,
  stopDesktopWatch,
} from "./foreground";

/**
 * Whether the floating task notes belong on screen right now.
 *
 * ── What a task note is ──────────────────────────────────────────────────────
 * A DESKTOP widget. An allocated task rests on the user's desktop the way a
 * paper note rests on a monitor bezel: it is there when they can see the
 * desktop, whether or not BlissWork itself is open, and it stays there until
 * the task is Completed or Ignored.
 *
 * That gives two independent reasons for a note to be visible, and it is
 * visible if EITHER holds:
 *
 *   1. One of BlissWork's own windows has focus — the user is in the app, and a
 *      note over the app is a note over its own work.
 *   2. The bare desktop is what the user is looking at (./foreground) — nobody
 *      else's window is there to cover.
 *
 * And exactly one reason to be hidden: some OTHER application is in front. A
 * note must never cover work that is not ours.
 *
 * ── Why both halves are needed ───────────────────────────────────────────────
 * Answering from Electron's window lifecycle alone is what broke this feature.
 * Electron knows about BlissWork's own windows and nothing else, so "BlissWork
 * is not focused" was read as "hide the notes" — which also fires when the user
 * minimises everything, closes BlissWork to the tray, or presses Win+D. Every
 * one of those is a user LOOKING AT THEIR DESKTOP, the exact moment a desktop
 * note is supposed to be there, and all of them made the pinned tasks vanish.
 *
 * So `minimized` and `hidden` no longer take the notes away by themselves. They
 * still disqualify the FOCUS half (a minimized window reporting focus is a
 * platform quirk, not a user in the app), but the desktop half answers for
 * itself, which is why closing to the tray now leaves the notes where they are.
 *
 * ── Why the OS half is a poll, and why it fails closed ───────────────────────
 * Electron has no event for "some other application came to the front", so the
 * desktop half has to be sampled — see ./foreground, which also explains why
 * "unknown" there means NOT the desktop. Failing closed is what makes it safe
 * to consult at all: a machine that cannot answer falls back to reason 1 alone,
 * which is the conservative behaviour, never the global always-on-top one.
 *
 * ── Why the answer is coalesced ──────────────────────────────────────────────
 * Moving focus between two of BlissWork's own windows fires `blur` on the first
 * before `focus` on the second. Acting on the blur alone would hide every note
 * for a frame every time the user clicked from the main window to a chat note.
 * Every event therefore schedules ONE re-read on the next turn of the loop, by
 * which time focus has landed and `BrowserWindow.isFocused()` is truthful.
 */

/** What BlissWork's own windows are doing, as far as the OS is concerned. */
export interface AppPresence {
  /** One of BlissWork's OWN windows holds keyboard focus. */
  focused: boolean;
  /** The main window is minimized. */
  minimized: boolean;
  /** The main window is hidden — closed to tray, started at login, or absent. */
  hidden: boolean;
}

/**
 * Is the user IN BlissWork right now — reason 1 above, kept pure.
 *
 * Minimized and hidden are checked EXPLICITLY rather than left to `focused`.
 * A minimized window cannot hold focus on any platform we ship to, so this is
 * belt-and-braces against a platform reporting focus for a window the user
 * cannot see.
 *
 * Note what this does NOT decide any more: whether a note is on screen. A
 * minimized or tray-bound BlissWork is not "in use", but its notes still rest
 * on the desktop. That is `shouldFloatNotes`.
 */
export function isAppActive(presence: AppPresence): boolean {
  if (presence.hidden || presence.minimized) return false;
  return presence.focused;
}

/**
 * The note-visibility policy — reason 1 OR reason 2 — kept pure so it can be
 * tested without an OS.
 *
 * `desktopShowing` comes from ./foreground and is false whenever that reading
 * is unavailable, so on a machine that cannot answer this collapses to
 * `isAppActive` rather than to "always show".
 */
export function shouldFloatNotes(
  presence: AppPresence,
  desktopShowing: boolean,
): boolean {
  return isAppActive(presence) || desktopShowing;
}

/**
 * The main window, whose minimize/hide state feeds the focus half. Held as a
 * variable rather than captured once because it can be recreated (macOS
 * `activate`, and the tray path when it has been destroyed).
 */
let mainWindow: BrowserWindow | null = null;
let floating = false;
let started = false;
let pending: NodeJS.Immediate | null = null;
let unsubscribeDesktop: (() => void) | null = null;
const listeners = new Set<(floating: boolean) => void>();

/** Best current answer. Starts FALSE: a note must never be shown on the
 *  assumption that the desktop is in front — the first read settles it. */
export function shouldFloatNotesNow(): boolean {
  return floating;
}

/** Subscribe to changes. Returns an unsubscribe. */
export function onShouldFloatChange(cb: (floating: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function evaluate(): void {
  pending = null;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const next = shouldFloatNotes(
    {
      // ANY of our windows counts, which is what makes the main window and its
      // task notes one application context: clicking a note (or a chat note, or
      // a future second window) is not leaving BlissWork. Task notes are
      // `focusable: false` so they never report focus themselves — they are
      // carried by whichever window does.
      focused: BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
      minimized: !!win?.isMinimized(),
      hidden: !win || !win.isVisible(),
    },
    isDesktopShowingNow(),
  );
  if (next === floating) return;
  floating = next;
  for (const cb of listeners) cb(next);
}

function schedule(): void {
  if (pending) return;
  pending = setImmediate(evaluate);
}

/**
 * Focus changed on one of our own windows. Re-read, and also poke the OS
 * sampler: leaving BlissWork for another application and coming back to the
 * bare desktop are the two transitions where the poll's lag is most visible,
 * and Electron tells us about both the instant they happen.
 */
function scheduleAndPoke(): void {
  schedule();
  pokeDesktopWatch();
}

/**
 * Follow the main window. Call on every creation of it — including a
 * recreation — so the gate keeps tracking the window that actually exists.
 *
 * Listeners are registered one by one: Electron's `on` overloads are per
 * event name, so a loop over a union of names does not typecheck. Focus and
 * blur are NOT among them — `app`'s own browser-window-focus/blur below cover
 * every window at once, including this one.
 */
export function trackMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
  if (win) {
    win.on("minimize", scheduleAndPoke);
    win.on("restore", scheduleAndPoke);
    win.on("show", scheduleAndPoke);
    win.on("hide", scheduleAndPoke);
    win.on("closed", scheduleAndPoke);
  }
  schedule();
}

/** Begin watching. Safe to call twice. */
export function startAppActiveWatch(): void {
  if (started) return;
  started = true;
  app.on("browser-window-focus", scheduleAndPoke);
  app.on("browser-window-blur", scheduleAndPoke);
  // macOS activates and deactivates the APPLICATION, which can happen without
  // any individual window emitting anything (⌘-tab away with the main window
  // already unfocused, for one). Never fires on Windows/Linux.
  app.on("did-become-active", scheduleAndPoke);
  app.on("did-resign-active", scheduleAndPoke);
  // The desktop half. Its answers arrive on their own schedule (a poll), so it
  // gets its own subscription rather than being read only when Electron
  // happens to fire something.
  unsubscribeDesktop = onDesktopShowingChange(schedule);
  void startDesktopWatch();
  evaluate();
}

export function stopAppActiveWatch(): void {
  if (pending) clearImmediate(pending);
  pending = null;
  app.removeListener("browser-window-focus", scheduleAndPoke);
  app.removeListener("browser-window-blur", scheduleAndPoke);
  app.removeListener("did-become-active", scheduleAndPoke);
  app.removeListener("did-resign-active", scheduleAndPoke);
  unsubscribeDesktop?.();
  unsubscribeDesktop = null;
  stopDesktopWatch();
  started = false;
}
