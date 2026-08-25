import { app, Menu, shell, dialog, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { appIcon } from "./assets";

/**
 * Standard application menu. Hidden behind autoHideMenuBar on Windows/Linux
 * (press Alt to reveal) but its accelerators — copy/paste, reload, devtools,
 * zoom, quit — always work, which a "proper" desktop app is expected to honor.
 */
export function buildAppMenu(opts: { onShow: () => void; onQuit: () => void }): Menu {
  const isMac = process.platform === "darwin";

  const about = () => {
    void dialog.showMessageBox({
      type: "info",
      title: "About BlissWork",
      message: "BlissWork",
      detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n\nTeam messaging + tasks with always-on-top sticky notes.`,
      icon: appIcon(),
      buttons: ["OK"],
    });
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Show BlissWork", click: opts.onShow },
        { type: "separator" },
        { label: "Quit", accelerator: isMac ? "Cmd+Q" : "Ctrl+Q", click: opts.onQuit },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        // Electron's default zoomIn accelerator is "CmdOrCtrl+Plus", which
        // only matches Shift+=. Add "CmdOrCtrl+=" so the unshifted key users
        // instinctively press (as in Chrome/VS Code) also zooms in; keep the
        // default bound too (hidden) for numpad "+".
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "BlissWork on the Web", click: () => void shell.openExternal("https://communication.rnrtechs.com") },
        { type: "separator" },
        { label: "About BlissWork", click: about },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
