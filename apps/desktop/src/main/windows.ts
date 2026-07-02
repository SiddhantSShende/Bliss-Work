import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";

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
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(rendererDir, "index.html"));

  return win;
}

export function createStickyWindow(taskId: string, index: number, collapsed = false): BrowserWindow {
  // DESKTOP WIDGET — the note floats on the user's MAIN desktop screen (primary
  // display) and layers above normal windows so an allocated task is visible
  // without being buried. It is intentionally NOT pinned over every app/virtual
  // desktop: we use the lightest always-on-top level ("floating", set below) and
  // the main window's focus lowers it (StickyManager.lowerZOrder) so the app
  // stays fully usable. `showInactive()` surfaces it WITHOUT stealing focus;
  // `skipTaskbar` keeps it out of the taskbar — it's an ambient widget. The
  // StickyManager confines its position to the primary display.
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
    type: "desktop",
    hasShadow: true,
    maximizable: false,
    minimizable: false, // can't be minimised — it's already an unframed widget
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: preloadSticky,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--task-id=${taskId}`],
    },
  });

  win.setAlwaysOnTop(false);

  const query = `?taskId=${encodeURIComponent(taskId)}&i=${index}${collapsed ? "&collapsed=1" : ""}`;
  if (DEV_URL) void win.loadURL(`${DEV_URL}/sticky.html${query}`);
  else void win.loadFile(join(rendererDir, "sticky.html"), { search: query });

  // Surface on top the moment it's ready, without grabbing keyboard focus.
  win.on("ready-to-show", () => {
    win.showInactive();
  });
  return win;
}
