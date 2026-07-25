import { app, dialog } from "electron";
import electronUpdater from "electron-updater";

// electron-updater ships CommonJS; under ESM interop the named exports live on the
// default export object.
const { autoUpdater } = electronUpdater;

/**
 * Wire GitHub-releases auto-update for the packaged NSIS build.
 *
 * The publish config in package.json (provider: github, SiddhantSShende/Bliss-Work)
 * is baked into app-update.yml at build time, so electron-updater knows where to
 * look with no runtime config. On launch it checks for a newer release; if one is
 * found it downloads in the background and, once ready, offers a restart.
 *
 * Deliberately skipped for:
 *   - dev runs (no packaged app / no update feed), and
 *   - the Microsoft Store (AppX/MSIX) build — the Store manages those updates, and
 *     electron-updater cannot self-install a Store package. `process.windowsStore`
 *     is true only when running as a Store app.
 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return;
  if ((process as NodeJS.Process & { windowsStore?: boolean }).windowsStore) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err: Error) => {
    // Never surface update failures to the user (offline, rate-limited, etc.) —
    // the app keeps running on the current version and retries next launch.
    console.error("[updater] error:", err?.message ?? err);
  });

  autoUpdater.on("update-available", (info: { version: string }) => {
    console.log("[updater] update available:", info.version);
  });

  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update ready",
        message: `BlissWork ${info.version} is ready to install.`,
        detail: "Restart the app to apply the update. It will also install automatically the next time you quit.",
      })
      .then(({ response }) => {
        // Defer so the dialog is fully dismissed before the app relaunches.
        if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
      });
  });

  autoUpdater.checkForUpdates().catch((e: unknown) => {
    console.error("[updater] check failed:", e instanceof Error ? e.message : e);
  });
}
