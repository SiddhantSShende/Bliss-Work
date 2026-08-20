import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";
import { isDesktopCurrentlyExposed } from "./foreground";
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

export function createStickyWindow(taskId: string, index: number, collapsed = false): BrowserWindow {
  // DESKTOP-PINNED TASK NOTE — an allocated task is pinned to the user's MAIN
  // desktop (home screen), BEHIND every application window. It must NEVER float
  // over an open app or sit on top of other windows; it lives at the desktop
  // layer like a wallpaper widget, visible only when the desktop is (Show
  // Desktop / everything minimised). This is deliberate per product spec.
  //
  // How the "always behind" is achieved without a native module, per platform:
  //
  //   • LINUX — type: "desktop" maps to _NET_WM_WINDOW_TYPE_DESKTOP and the
  //     window manager keeps the window at the very bottom of the stack. Real
  //     layering: the note stays put, stays clickable, and is simply never in
  //     the way.
  //
  //   • WINDOWS and macOS — the type is NOT set, and ./foreground hides the note
  //     while another application is in front instead. Neither platform can do
  //     what Linux does here:
  //       – Windows supports only type: "toolbar"; "desktop" is silently
  //         ignored, and Electron has no API to lower a window in the z-order,
  //         so a shown note sits ON TOP of the front app until something else
  //         is raised over it.
  //       – macOS does support type: "desktop", but such a window "will not
  //         receive focus, keyboard or mouse events" — which would leave
  //         Acknowledge, Ignore and Complete dead, and those are the note.
  //
  //   • focusable: false → the note can never take focus or be raised to the
  //     front by a click, so opening/clicking any app leaves it behind, and
  //     clicking the note itself does not change which app is in front (which is
  //     what lets a note stay visible while its buttons are being used). Task
  //     actions are pure click targets — no text input — so this costs nothing.
  //   • alwaysOnTop: false + skipTaskbar: true → never promoted above apps, and
  //     kept out of the taskbar/alt-tab (it's an ambient desktop widget).
  //   • showInactive() (below) surfaces it WITHOUT stealing focus.
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
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: false,
    focusable: false, // never raises to the front — stays pinned behind all apps
    // Linux only: elsewhere this is either ignored (Windows) or costs the note
    // every mouse event (macOS). See the note above.
    ...(process.platform === "linux" ? { type: "desktop" } : {}),
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

  // Belt-and-suspenders: a note must never be left promoted above app windows.
  // This only re-asserts the constructor option — moveTop has no inverse, so
  // what actually keeps the note out of the way is type:"desktop" on Linux and
  // ./foreground hiding it on Windows and macOS.
  win.setAlwaysOnTop(false);

  hardenWindow(win, "sticky");

  const query = `?taskId=${encodeURIComponent(taskId)}&i=${index}${collapsed ? "&collapsed=1" : ""}`;
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Show it without grabbing keyboard focus — but only if the desktop is what
  // the user is looking at. A task allocated while someone is in another
  // application must not appear over their work, and on Windows a freshly shown
  // window goes to the top of the stack, so "show it and let it fall behind" is
  // not available. The watcher shows it the moment they return to the desktop.
  win.on("ready-to-show", () => {
    if (isDesktopCurrentlyExposed()) win.showInactive();
  });
  return win;
}
