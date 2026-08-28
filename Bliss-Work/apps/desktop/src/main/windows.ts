import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";
import { isSafeToFloatNow } from "./foreground";
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
  // DESKTOP-PINNED TASK NOTE — an allocated task floats as a small widget that
  // stays ABOVE BlissWork's own windows while BlissWork is what the user is
  // looking at (any of its windows, or the bare desktop), and gets out of the
  // way — hidden, never merely un-topmost — the instant a DIFFERENT
  // application is frontmost. It is a desktop task widget, not a global
  // always-on-top window: nothing here ever floats above another app.
  //
  // How that is achieved, per platform — see ./foreground (isSafeToFloat) for
  // the "is BlissWork frontmost" detection this all keys off:
  //
  //   • WINDOWS and macOS — real `alwaysOnTop`, toggled dynamically by
  //     StickyManager.setSafeToFloat() in step with ./foreground's poll:
  //     true while BlissWork itself is frontmost (so clicking around the main
  //     window does not bury the note behind it — a non-topmost window falls
  //     behind whatever is clicked), false the instant another app is, paired
  //     with hiding the note so it can never even flicker above someone
  //     else's work in the gap between the two.
  //
  //   • LINUX — type: "desktop" maps to _NET_WM_WINDOW_TYPE_DESKTOP and the
  //     window manager keeps the window at the bottom of the stack for real;
  //     ./foreground's poll does not run there at all (isSafeToFloat is
  //     always true), so alwaysOnTop is simply never turned on.
  //
  //   • focusable: false → the note can never take focus or be raised to the
  //     front by a click, so its own alwaysOnTop toggling never fights the
  //     user for keyboard focus, and clicking the note itself does not count
  //     as "leaving BlissWork" for the purposes of ./foreground's poll. Task
  //     actions are pure click targets — no text input — so this costs
  //     nothing.
  //   • skipTaskbar: true → kept out of the taskbar/alt-tab, since it is an
  //     ambient widget, not a window someone switches to directly.
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
    // false, not true: on a transparent frameless window the native OS shadow
    // is drawn around the whole WINDOW RECTANGLE — including the fully
    // transparent padding around the rounded card — not the visible card
    // itself. Stacked with the card's own CSS shadow-widget, that read as a
    // hazy rectangular halo behind the note. The CSS shadow alone (used by
    // every other floating widget in the app — MiniMeeting, BrowserStickies,
    // MeetingHost, sticky-chat) already traces the actual rounded shape.
    hasShadow: false,
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

  // Safe starting state: not promoted above anything until the very first
  // ./foreground poll confirms BlissWork is actually what's frontmost — a
  // note must never even flicker above another app while that first answer
  // is still in flight. Re-asserts the constructor option; belt-and-suspenders.
  win.setAlwaysOnTop(false);

  hardenWindow(win, "sticky");

  const query = `?taskId=${encodeURIComponent(taskId)}&i=${index}${collapsed ? "&collapsed=1" : ""}`;
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Show it without grabbing keyboard focus — but only if it is currently
  // safe to float (BlissWork frontmost, or the bare desktop). A task
  // allocated while someone is in another application must not appear over
  // their work. The watcher (./foreground) raises and shows it the moment
  // that changes; this only covers the window between creation and the next
  // poll tick.
  win.on("ready-to-show", () => {
    if (isSafeToFloatNow()) {
      win.showInactive();
      win.setAlwaysOnTop(true);
    }
  });
  return win;
}
