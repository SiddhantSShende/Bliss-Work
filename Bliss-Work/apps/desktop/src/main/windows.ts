import { BrowserWindow } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

const preloadMain = join(here, "../preload/index.js");
const preloadSticky = join(here, "../preload/sticky.js");
const rendererDir = join(here, "../renderer");

export function createMainWindow(startHidden = false): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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

  // When auto-started at login we stay in the tray + reload any persisted
  // sticky notes (the StickyManager restores them from sticky-state.json on
  // its own); the main window only shows when the user clicks the tray icon.
  // Otherwise show normally so first-launch feels like a normal app start.
  win.on("ready-to-show", () => {
    if (!startHidden) win.show();
  });
  hardenWindow(win, "main");

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(rendererDir, "index.html"));

  return win;
}

export function createStickyWindow(taskId: string, index: number, collapsed = false): BrowserWindow {
  // DESKTOP-PINNED TASK NOTE — an allocated task is pinned to the user's MAIN
  // desktop (home screen), BEHIND every application window. It must NEVER float
  // over an open app or sit on top of other windows; it lives at the desktop
  // layer like a wallpaper widget, visible only when the desktop is (Show
  // Desktop / everything minimised). This is deliberate per product spec.
  //
  // How the "always behind" is achieved without a native module:
  //   • type: "desktop"  → on X11/Linux maps to _NET_WM_WINDOW_TYPE_DESKTOP, so
  //     the window manager keeps the window at the very bottom of the stack.
  //   • focusable: false → the note can never take focus or be raised to the
  //     front by a click, so opening/clicking any app leaves it behind. Task
  //     actions are pure click targets (Acknowledge / Ignore / Complete /
  //     Collapse) — no text input — so a non-focusable window stays fully usable.
  //   • alwaysOnTop: false + skipTaskbar: true → never promoted above apps, and
  //     kept out of the taskbar/alt-tab (it's an ambient desktop widget).
  //   • showInactive() (below) surfaces it WITHOUT stealing focus.
  // The StickyManager confines its position to the primary display.
  const win = new BrowserWindow({
    width: 320,
    height: 200,
    minWidth: 240,
    minHeight: 140,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: false,
    focusable: false, // never raises to the front — stays pinned behind all apps
    type: "desktop",
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

  // Belt-and-suspenders: force the note to sit at the bottom of the window
  // stack, never on top. moveTop has no inverse, so type:"desktop" +
  // focusable:false above are what actually keep it behind on each platform.
  win.setAlwaysOnTop(false);

  hardenWindow(win, "sticky");

  const query = `?taskId=${encodeURIComponent(taskId)}&i=${index}${collapsed ? "&collapsed=1" : ""}`;
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Surface on top the moment it's ready, without grabbing keyboard focus.
  win.on("ready-to-show", () => {
    win.showInactive();
  });
  return win;
}
