import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { attachToDesktopLayer } from "./desktop-layer";
import { hardenWindow } from "./harden";
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

/**
 * The OS title bar is hidden and the app's own top bar (TopNavbar) takes its
 * place, so there is ONE header instead of two. The native min/max/close
 * buttons are kept — Electron draws them over the right edge of that bar
 * (`titleBarOverlay`), so they stay the real OS controls, snap layouts and all.
 * This height must equal TopNavbar's own height (h-12 = 48px) or the controls
 * and the bar disagree. macOS has no right-hand overlay: its traffic lights stay
 * at the left, inside the bar, and TopNavbar leaves room for them.
 */
export const MAIN_TITLE_BAR_HEIGHT = 48;

/** Narrowest main window the top bar can lay out in (see minWidth below). */
export const MAIN_MIN_WIDTH = 520;

/** Colours the overlay is drawn in until the renderer reports the active
 *  theme's (main/index.ts "window:title-bar-theme") — matches backgroundColor. */
const INITIAL_OVERLAY = { color: "#16181f", symbolColor: "#e5e7eb" };

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
    // tablet/mobile responsive layouts too, not just the desktop one. Not below
    // 520: the single top bar (TopNavbar) must hold its seven controls PLUS the
    // native window controls drawn over it — 138px on Windows — and measured
    // against the real bar (text-only wordmark, 17px at this width) that is
    // ~510px at its most compact. Narrower and the org/search buttons overlap
    // and the profile button would slide under the native controls.
    minWidth: MAIN_MIN_WIDTH,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#16181f",
    icon: appIcon(),
    title: "BlissWork",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: (MAIN_TITLE_BAR_HEIGHT - 14) / 2 } }
      : { titleBarOverlay: { ...INITIAL_OVERLAY, height: MAIN_TITLE_BAR_HEIGHT } }),
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
  // PINNED TASK POPUP — a persistent desktop widget. An allocated task stays on
  // screen until it is completed, ignored or the user clicks Unpin. Opening or
  // switching to another application never hides or minimises it.
  //
  // Where it sits differs by platform:
  //   • WINDOWS — on the DESKTOP layer: above the wallpaper and icons, below every
  //     normal application, so it never floats over Chrome or an editor and needs
  //     no click on the desktop to reappear. Electron cannot express that, so
  //     desktop-layer.ts places the window with a Win32 call; if that is
  //     unavailable the note is still an ordinary non-topmost window.
  //   • macOS / Linux — alwaysOnTop at the "screen-saver" level (the highest
  //     Electron offers), visible on all workspaces and over fullscreen apps.
  //     `type: "desktop"` is deliberately not used: it parked the note behind
  //     every window on Linux.
  //
  // Why NOT an Electron child window (`parent`), which this briefly was: an
  // owned window is bound to its owner's lifecycle, so it follows the main
  // window into a minimize and cannot be shown while the owner is hidden. The
  // note has to outlive BlissWork's own window — minimised, or closed to the
  // tray.
  //
  //   • focusable: false → the note can never take focus or be raised to the
  //     front by a click, so clicking it never pulls focus off whatever the user
  //     is working in and it never fights them for the keyboard. Task actions
  //     are pure click targets — no text input — so this costs nothing. (On
  //     Linux it also keeps the window manager from managing it as a normal
  //     window, which is what lets it stay on top across workspaces.)
  //   • skipTaskbar: true → kept out of the taskbar/alt-tab, since it is a
  //     desktop widget, not a window someone switches to directly.
  //   • showInactive() (below) surfaces it WITHOUT stealing focus.
  //
  // The StickyManager confines its position to the primary display.
  const onDesktopLayer = process.platform === "win32";
  const win = new BrowserWindow({
    // Wide enough for "Acknowledge" and "Ignore" to sit side by side with their
    // text labels. The note used to render those two as bare icons to fit 320px,
    // which is unusable on a window that cannot take keyboard focus and only
    // shows tooltips on hover. +20px over the old single-task width to make room
    // for the carousel's ‹ › gutters (renderer/sticky.tsx) without re-cramping
    // that row — the whole point of the width this replaced.
    width: 380,
    // Tall enough for the title, the Assigned/Due row and the Acknowledge/Ignore
    // row AND a few readable lines of description: the card is height-capped, so
    // the description is what absorbs any shortfall (see StickyWidget). At the old
    // 200px (min 140) it was squeezed to a single line, or to nothing.
    height: 340,
    minWidth: 320,
    minHeight: 300,
    // Capped close to content size: this window is opaque (see the transparent
    // note below), so an unbounded resize left a big flat-coloured rectangle
    // around the card — exactly the "background/container behind the task"
    // look. The cap keeps the note a compact widget no matter how far the user
    // drags its corner.
    maxWidth: 440,
    maxHeight: 440,
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
    // Topmost from the first frame off Windows; on Windows the note is NOT topmost.
    alwaysOnTop: !onDesktopLayer,
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

  if (onDesktopLayer) {
    attachToDesktopLayer(win);
  } else {
    // Highest priority in the window stack. The constructor flag alone puts the
    // note at the ordinary "floating" level, which a fullscreen app or another
    // topmost window can sit over; "screen-saver" is the top of the stack.
    win.setAlwaysOnTop(true, "screen-saver");
    // Follow the user across workspaces and into fullscreen spaces.
    // skipTransformProcessType keeps macOS from flickering the Dock icon away.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  // No taskId in the query any more — this one window carries the whole
  // carousel, pushed over IPC (sticky:task*) once the renderer is ready.
  const query = collapsed ? "?collapsed=1" : "";
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Show it without grabbing keyboard focus. Unconditional: a task allocated
  // while the user is in another application is shown at once — the note does
  // not wait for the user to come back to BlissWork.
  win.on("ready-to-show", () => win.showInactive());
  return win;
}
