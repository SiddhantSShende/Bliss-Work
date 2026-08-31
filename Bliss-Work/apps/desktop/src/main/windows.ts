import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";
import { isAppActiveNow } from "./app-active";
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
    minWidth: 1280,
    minHeight: 700,
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

export function createStickyWindow(
  taskId: string,
  index: number,
  collapsed = false,
  parent: BrowserWindow | null = null,
): BrowserWindow {
  // DESKTOP-PINNED TASK NOTE — an allocated task floats as a small companion
  // window of the BlissWork application. It stays ABOVE BlissWork's own windows
  // while the user is in BlissWork, and is hidden the instant they are not.
  // Nothing here ever floats above another application.
  //
  // How that is achieved:
  //
  //   • `parent` — the note is an Electron CHILD of the main window, i.e. an
  //     OWNED window at the OS level (an owner relationship on Windows, an
  //     NSWindow child on macOS, WM_TRANSIENT_FOR on Linux). The OS keeps an
  //     owned window above its owner and ONLY above its owner: it cannot rise
  //     above another application even in principle, and it follows the owner
  //     into and out of a minimize. This is what replaced the previous
  //     `alwaysOnTop` toggling — see ./app-active for why that mechanism could
  //     not keep the promise it made.
  //
  //   • alwaysOnTop is NEVER turned on, on any platform. `false` is set at
  //     construction and re-asserted below; ownership is the entire z-order
  //     story. Visibility is the whole of the rest of it: ./app-active drives
  //     StickyManager.setAppActive(), which shows and hides the note as the
  //     user enters and leaves BlissWork.
  //
  //   • focusable: false → the note can never take focus or be raised to the
  //     front by a click. That is what makes clicking a note NOT count as
  //     leaving BlissWork (the main window keeps focus, so the app-wide focus
  //     read in ./app-active stays true) and keeps the note from ever fighting
  //     the user for the keyboard. Task actions are pure click targets — no
  //     text input — so this costs nothing.
  //   • skipTaskbar: true → kept out of the taskbar/alt-tab, since it is a
  //     companion widget, not a window someone switches to directly.
  //   • showInactive() (below) surfaces it WITHOUT stealing focus.
  //
  // NOT set: `type: "desktop"` on Linux, which this window used to carry. That
  // maps to _NET_WM_WINDOW_TYPE_DESKTOP and pins the window to the BOTTOM of
  // the stack — under the ownership model that would bury every note behind
  // the very window it is a companion to, which is the opposite of the point.
  // The StickyManager confines its position to the primary display.
  const win = new BrowserWindow({
    // Wide enough for "Acknowledge" and "Ignore" to sit side by side with their
    // text labels. The note used to render those two as bare icons to fit 320px,
    // which is unusable on a window that cannot take keyboard focus and only
    // shows tooltips on hover.
    width: 360,
    height: 200,
    minWidth: 300,
    minHeight: 140,
    // Omitted rather than passed as null when there is no main window yet: the
    // bootstrap restore runs before the main window exists, and StickyManager
    // adopts those notes via setParentWindow() the moment it does.
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: false,
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
      additionalArguments: [`--task-id=${taskId}`],
    },
  });

  // Re-asserts the constructor option. Deliberately the ONLY setAlwaysOnTop
  // call on this window, and deliberately `false`: a note must never be
  // promoted above anything, and the one way that regresses is somebody
  // reaching for `true` here again.
  win.setAlwaysOnTop(false);

  hardenWindow(win, "sticky");

  const query = `?taskId=${encodeURIComponent(taskId)}&i=${index}${collapsed ? "&collapsed=1" : ""}`;
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Show it without grabbing keyboard focus — but only if BlissWork is the
  // application the user is actually in. A task allocated while someone is in
  // another application must not appear over their work; it waits, and
  // StickyManager.setAppActive() brings it up the moment they come back.
  win.on("ready-to-show", () => {
    if (isAppActiveNow()) win.showInactive();
  });
  return win;
}
