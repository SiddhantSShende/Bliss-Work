import { app, BrowserWindow } from "electron";

/**
 * Whether BlissWork is the application the user is currently in — the single
 * signal that decides whether the floating task notes are on screen.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A task note is a companion window of the BlissWork app: visible while the
 * user is in BlissWork, gone the moment they switch to Chrome, VS Code, a file
 * browser or anything else. It must never cover another application's work.
 *
 * That is a statement about the APP, not about one window, and it cannot be
 * answered from the renderer (`document.hasFocus()` knows nothing about other
 * applications, and a note whose own document is never focused would answer
 * "no" forever). So it is answered here, in main, from Electron's own window
 * lifecycle.
 *
 * ── Why not poll the OS foreground window ────────────────────────────────────
 * This replaces a 1 s poll of the native `get-windows` foreground reader that
 * drove `setAlwaysOnTop(true/false)`. Two things were wrong with it and both
 * were unfixable without changing the mechanism:
 *
 *   * It defaulted to "safe to float" and stayed there when the native module
 *     failed to load (a packaged build, a mismatched Electron ABI, a Wayland
 *     session), which left every note GLOBALLY always-on-top over other
 *     applications — the exact thing the feature promises never to do.
 *   * Even when it worked, a poll answers late: for up to a second after the
 *     user alt-tabbed, a note was still sitting on top of someone else's work.
 *
 * Notes no longer use `alwaysOnTop` at all. They are Electron CHILD windows of
 * the main window (see createStickyWindow), so the OS itself keeps them above
 * BlissWork and only above BlissWork; this module then decides show vs hide.
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
 * The whole policy, kept pure so it can be tested without an OS.
 *
 * Minimized and hidden are checked EXPLICITLY rather than left to `focused`.
 * A minimized window cannot hold focus on any platform we ship to, so this is
 * belt-and-braces — but "BlissWork is minimized, therefore the note is off
 * screen" is a promise made to the user, and a promise that depends on a
 * platform detail happening to hold is one worth stating outright.
 */
export function isAppActive(presence: AppPresence): boolean {
  if (presence.hidden || presence.minimized) return false;
  return presence.focused;
}

/**
 * The window the notes are companions to. Its minimize/hide state gates them,
 * and it is the window they are OWNED by. Held as a variable rather than
 * captured once because the main window can be recreated (macOS `activate`,
 * and the tray path when it has been destroyed).
 */
let mainWindow: BrowserWindow | null = null;
let active = false;
let started = false;
let pending: NodeJS.Immediate | null = null;
const listeners = new Set<(active: boolean) => void>();

/** Best current answer. Starts FALSE: a note must never be shown on the
 *  assumption that BlissWork is in front — the first read settles it. */
export function isAppActiveNow(): boolean {
  return active;
}

/** Subscribe to changes. Returns an unsubscribe. */
export function onAppActiveChange(cb: (active: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function evaluate(): void {
  pending = null;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const next = isAppActive({
    // ANY of our windows counts, which is what makes the main window and its
    // task notes one application context: clicking a note (or a chat note, or
    // a future second window) is not leaving BlissWork. Task notes are
    // `focusable: false` so they never report focus themselves — they are
    // carried by whichever window does.
    focused: BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
    minimized: !!win?.isMinimized(),
    hidden: !win || !win.isVisible(),
  });
  if (next === active) return;
  active = next;
  for (const cb of listeners) cb(next);
}

function schedule(): void {
  if (pending) return;
  pending = setImmediate(evaluate);
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
    win.on("minimize", schedule);
    win.on("restore", schedule);
    win.on("show", schedule);
    win.on("hide", schedule);
    win.on("closed", schedule);
  }
  schedule();
}

/** Begin watching. Safe to call twice. */
export function startAppActiveWatch(): void {
  if (started) return;
  started = true;
  app.on("browser-window-focus", schedule);
  app.on("browser-window-blur", schedule);
  // macOS activates and deactivates the APPLICATION, which can happen without
  // any individual window emitting anything (⌘-tab away with the main window
  // already unfocused, for one). Never fires on Windows/Linux.
  app.on("did-become-active", schedule);
  app.on("did-resign-active", schedule);
  evaluate();
}

export function stopAppActiveWatch(): void {
  if (pending) clearImmediate(pending);
  pending = null;
  app.removeListener("browser-window-focus", schedule);
  app.removeListener("browser-window-blur", schedule);
  app.removeListener("did-become-active", schedule);
  app.removeListener("did-resign-active", schedule);
  started = false;
}
