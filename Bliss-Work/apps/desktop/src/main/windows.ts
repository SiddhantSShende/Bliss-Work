import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";
import { shouldFloatNotesNow } from "./app-active";
import { isSystemAway } from "./window-state-guard";
import { getMainWindowBounds, saveMainWindowBounds } from "./sticky-state";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

const preloadMain = join(here, "../preload/index.js");
const preloadSticky = join(here, "../preload/sticky.js");
const rendererDir = join(here, "../renderer");

/**
 * A stored rectangle is only usable if it still lands on a display that exists.
 * Unplugging the monitor a window was last closed on would otherwise reopen it
 * at coordinates no screen covers — the app looks like it failed to launch.
 * Require a real overlap, not merely a corner, so a window left one pixel onto
 * a since-removed display doesn't come back as a sliver.
 */
function isOnSomeDisplay(b: { x: number; y: number; width: number; height: number }): boolean {
  const MIN_VISIBLE = 120;
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const overlapX = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const overlapY = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

export function createMainWindow(startHidden = false): BrowserWindow {
  // Restore where the user left the window. Without this every launch was a
  // fresh 1180×800 at the OS default position, which is why an OS shutdown
  // looked like the app had "resized itself".
  const saved = getMainWindowBounds();
  const usable = saved && isOnSomeDisplay(saved) ? saved : undefined;

  const win = new BrowserWindow({
    ...(usable ? { x: usable.x, y: usable.y } : {}),
    width: usable?.width ?? 1440,
    height: usable?.height ?? 900,
    // Lowered from 1280x700 so the window can be shrunk into the app's
    // tablet/mobile responsive layouts too, not just the desktop one.
    minWidth: 320,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#16181f",
    icon: appIcon(),
    title: "BlissWork",
    webPreferences: {
      preload: preloadMain,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses ipcRenderer; contextIsolation still on
    },
  });

  // Maximize BEFORE first paint so the window doesn't visibly snap open at its
  // restored size and then grow.
  if (usable?.maximized) win.maximize();

  // When auto-started at login we stay in the tray + reload any persisted
  // sticky notes (the StickyManager restores them from sticky-state.json on
  // its own); the main window only shows when the user clicks the tray icon.
  // Otherwise show normally so first-launch feels like a normal app start.
  win.on("ready-to-show", () => {
    if (!startHidden) win.show();
  });

  wireBoundsPersistence(win);
  hardenWindow(win, "main");

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(rendererDir, "index.html"));

  return win;
}

/**
 * Keep sticky-state's record of the main window in step with reality.
 *
 * `getNormalBounds()` rather than `getBounds()`: while maximized the latter
 * reports the full screen, so storing it would make "restore down" a no-op on
 * the next launch. The maximized flag carries that state separately.
 *
 * Writes are debounced inside sticky-state, so a drag firing dozens of `move`
 * events costs one file write.
 */
function wireBoundsPersistence(win: BrowserWindow): void {
  const persist = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    // A resize that happened while the machine was locked or asleep is the
    // compositor's, not the user's. Recording it is how "the app changed its
    // own window size overnight" becomes permanent — the next launch opens at
    // whatever the system left behind. See window-state-guard.ts.
    if (isSystemAway()) return;
    const b = win.getNormalBounds();
    saveMainWindowBounds({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: win.isMaximized(),
    });
  };
  // Registered one by one: Electron's `on` overloads are per-event-name, so a
  // loop over a union of names does not typecheck.
  win.on("resized", persist);
  win.on("moved", persist);
  win.on("maximize", persist);
  win.on("unmaximize", persist);
  // The close path matters most: an OS shutdown closes the window without ever
  // emitting a resize, and this is the last moment its geometry exists.
  win.on("close", persist);
}

export function createStickyWindow(collapsed = false): BrowserWindow {
  // DESKTOP-PINNED TASK NOTE — an allocated task rests on the user's DESKTOP,
  // the way a paper note rests on a monitor bezel. It is there whenever the
  // desktop is what they are looking at, whether or not BlissWork is open, and
  // it stays until the task is Completed or Ignored. It is never over another
  // application.
  //
  // How that is achieved, per platform:
  //
  //   • WINDOWS and macOS — real `alwaysOnTop`, toggled by StickyManager in
  //     step with ./app-active: ON while BlissWork is frontmost OR the bare
  //     desktop is showing, OFF the instant another application is. Electron's
  //     `alwaysOnTop` is a single global flag with no "above my own windows
  //     only" setting, so toggling it in step with that reading is the only way
  //     to get a note that rests on the desktop without ever covering someone
  //     else's work.
  //
  //   • LINUX — `type: "desktop"` maps to _NET_WM_WINDOW_TYPE_DESKTOP, which
  //     parks the window at the BOTTOM of the real stack, on the wallpaper
  //     layer. That is a note ON the desktop in the most literal sense: it can
  //     never be in anybody's way, so alwaysOnTop is simply never turned on
  //     there and nothing ever has to be hidden.
  //
  // Why NOT an Electron child window (`parent`), which this briefly was: an
  // owned window is bound to its owner's lifecycle, so it follows the main
  // window into a minimize and cannot be shown while the owner is hidden. That
  // makes the note a companion to the APP rather than a widget on the DESKTOP,
  // and it is what made pinned tasks vanish on Win+D, on minimise, and on
  // close-to-tray. Ownership and "rests on the desktop" are mutually exclusive.
  //
  //   • focusable: false → the note can never take focus or be raised to the
  //     front by a click. That is what makes clicking a note NOT count as
  //     leaving BlissWork (the main window keeps focus, so the app-wide focus
  //     read in ./app-active stays true) and keeps the note from ever fighting
  //     the user for the keyboard, and it means its own alwaysOnTop toggling
  //     never fights the window manager. Task actions are pure click targets —
  //     no text input — so this costs nothing.
  //   • skipTaskbar: true → kept out of the taskbar/alt-tab, since it is a
  //     desktop widget, not a window someone switches to directly.
  //   • showInactive() (below) surfaces it WITHOUT stealing focus.
  //
  // The StickyManager confines its position to the primary display.
  const win = new BrowserWindow({
    // Wide enough for "Acknowledge" and "Ignore" to sit side by side with their
    // text labels. The note used to render those two as bare icons to fit 320px,
    // which is unusable on a window that cannot take keyboard focus and only
    // shows tooltips on hover. +20px over the old single-task width to make room
    // for the carousel's ‹ › gutters (renderer/sticky.tsx) without re-cramping
    // that row — the whole point of the width this replaced.
    width: 380,
    height: 200,
    minWidth: 320,
    minHeight: 140,
    // Capped close to content size: this window is opaque (see the transparent
    // note below), so an unbounded resize left a big flat-coloured rectangle
    // around the card — exactly the "background/container behind the task"
    // look. The cap keeps the note a compact widget no matter how far the user
    // drags its corner.
    maxWidth: 440,
    maxHeight: 260,
    frame: false,
    // false, not true: a transparent frameless window needs GPU compositing
    // to actually render as see-through, and on a Linux session without a
    // compositing window manager (common — no WM here at all is the extreme
    // case, but plenty of real ones run without compositing too) Chromium
    // falls back to painting the FULL window rectangle opaque instead — the
    // small task card ends up sitting inside a large, wrongly-coloured block
    // that reads as "the whole background came with it". An ordinary opaque
    // window has no such fallback to fail: it always renders exactly what it
    // is asked to. `backgroundColor` below keeps the tiny rounded-corner
    // cutouts around the card (the only bit of the window the card doesn't
    // paint itself) matching the card's own colour instead of showing a
    // visible square edge — see useSyncedTheme in ../renderer/sticky.tsx,
    // which keeps it in step with the active theme over "sticky:bg".
    transparent: false,
    backgroundColor: "#ffffff",
    resizable: true,
    movable: true,
    skipTaskbar: true,
    // Starts false on every platform. On win32/darwin StickyManager turns it on
    // as soon as the desktop reading says it is safe; on Linux it stays off for
    // good, because `type: "desktop"` below is the mechanism there instead.
    alwaysOnTop: false,
    ...(process.platform === "linux" ? { type: "desktop" as const } : {}),
    focusable: false, // never raises to the front, never steals focus
    hasShadow: true,
    maximizable: false,
    minimizable: false, // can't be minimised — it's already an unframed widget
    fullscreenable: false,
    show: false,
    // Frameless + skipTaskbar means this icon is rarely seen, but it is what
    // alt-tab, the window switcher and any OS-level window list fall back to —
    // without it those show the stock Electron mark.
    icon: appIcon(),
    webPreferences: {
      preload: preloadSticky,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  hardenWindow(win, "sticky");

  // No taskId in the query any more — this one window carries the whole
  // carousel, pushed over IPC (sticky:task*) once the renderer is ready.
  const query = collapsed ? "?collapsed=1" : "";
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Show it without grabbing keyboard focus — but only while it is safe to be
  // on screen. A task allocated while someone is in another application must
  // not appear over their work; it waits, and StickyManager.setSafeToFloat()
  // brings it up the moment they return to BlissWork or to the desktop.
  win.on("ready-to-show", () => {
    if (!shouldFloatNotesNow()) return;
    win.showInactive();
    setNoteOnTop(win, true);
  });
  return win;
}

/**
 * Raise or drop a note's always-on-top flag.
 *
 * A no-op on Linux, where `type: "desktop"` already parks the note at the
 * bottom of the stack: promoting it there would lift it off the wallpaper layer
 * and defeat the whole mechanism. Shared with StickyManager so both places
 * apply the same platform rule rather than each remembering it.
 */
export function setNoteOnTop(win: BrowserWindow, onTop: boolean): void {
  if (process.platform === "linux") return;
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(onTop);
}
