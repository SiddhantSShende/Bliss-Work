import { app, Menu, shell, dialog, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { appIcon } from "./assets";
import { mainT } from "./i18n";

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
      title: mainT("menu.aboutTitle"),
      message: mainT("menu.aboutMessage"),
      detail: mainT("menu.aboutDetail", {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
      }),
      icon: appIcon(),
      buttons: [mainT("menu.ok")],
    });
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: mainT("menu.file"),
      submenu: [
        { label: mainT("menu.showApp"), click: opts.onShow },
        { type: "separator" },
        { label: mainT("menu.quit"), accelerator: isMac ? "Cmd+Q" : "Ctrl+Q", click: opts.onQuit },
      ],
    },
    { role: "editMenu" },
    {
      label: mainT("menu.view"),
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
        { label: mainT("menu.webHelp"), click: () => void shell.openExternal("https://communication.rnrtechs.com") },
        { type: "separator" },
        { label: mainT("menu.aboutItem"), click: about },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
