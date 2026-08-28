import { app, dialog } from "electron";
import electronUpdater from "electron-updater";

// electron-updater ships CommonJS; under ESM interop the named exports live on the
// default export object.
const { autoUpdater } = electronUpdater;

/**
 * Wire auto-update for the packaged NSIS / AppImage / dmg builds.
 *
 * The feed is our OWN download host, not GitHub Releases: the publish config in
 * package.json (`provider: generic`, https://communication.rnrtechs.com/downloads)
 * is baked into app-update.yml at build time, so electron-updater knows where to
 * look with no runtime config. On launch it fetches `latest.yml` from there; if a
 * newer version is listed it downloads in the background and offers a restart.
 *
 * It has to be a generic feed because the repo is PRIVATE — a GitHub-provider
 * feed would need a token shipped inside the installer, where anyone can extract
 * it. CI publishes the installers and the latest*.yml manifests together
 * (.github/workflows/release.yml); the manifests are what make this work, and
 * their absence fails silently, so see docs/DEPLOY.md before changing that.
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

  check();

  // Re-check periodically, not only at launch. A desktop app routinely stays
  // open for days or weeks, so a launch-only check means a release sits
  // unnoticed until the user happens to restart — which, for someone who never
  // quits, is never. The point of shipping an update is that it arrives.
  //
  // Cheap: one conditional GET of latest.yml (a few hundred bytes) per interval,
  // and electron-updater ignores a check while a download is already running.
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  // Do not hold the event loop open on this alone — a pending timer must never
  // be the reason the process refuses to exit.
  timer.unref?.();
  app.on("before-quit", () => clearInterval(timer));
}

/**
 * How often a running app re-checks the feed on its own, and (see
 * checkOnWindowFocus below) the minimum gap enforced between any two checks so
 * rapid focus/blur cycling can't turn into a poll storm.
 *
 * electron-updater is a pure poller against a static latest.yml — there is no
 * server-side way to tell a running client "a new version just published" (see
 * the module comment above) — so how quickly an already-open app notices a
 * release is entirely a function of this number. 3 minutes rather than a
 * multi-hour interval so a release is noticed almost immediately by anyone
 * with the app open, while staying cheap: one conditional GET of a
 * few-hundred-byte file per client per interval.
 */
const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;

let lastCheckAt = 0;

function check(): void {
  lastCheckAt = Date.now();
  autoUpdater.checkForUpdates().catch((e: unknown) => {
    console.error("[updater] check failed:", e instanceof Error ? e.message : e);
  });
}

/**
 * Re-check the moment the main window regains focus — on top of the periodic
 * timer, this is the single most likely moment to catch someone actually
 * looking at the app right after a release went out (reopening it, or
 * alt-tabbing back to it). Debounced against whatever check ran most
 * recently, interval or focus-triggered, so switching focus back and forth
 * doesn't turn into a poll storm.
 */
export function checkOnWindowFocus(): void {
  if (!app.isPackaged) return;
  if ((process as NodeJS.Process & { windowsStore?: boolean }).windowsStore) return;
  if (Date.now() - lastCheckAt < MIN_CHECK_GAP_MS) return;
  check();
}

export interface UpdateCheckResult {
  status: "available" | "up-to-date" | "downloading" | "unsupported" | "error";
  version?: string;
  message?: string;
}

/**
 * Check for updates on demand, from Settings → About.
 *
 * The automatic check runs once at launch and says nothing when it finds
 * nothing, which is right for a background task and useless for a user asking
 * "am I up to date?". This one always answers.
 *
 * Never throws: a failed update check is not an app error, and the caller is a
 * button that has to say something either way.
 */
export async function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return {
      status: "unsupported",
      // A dev run has no update feed and its version is the repo's static
      // 0.1.0, so it would always look out of date. Say why.
      message: "Updates apply to installed builds only.",
    };
  }
  if ((process as NodeJS.Process & { windowsStore?: boolean }).windowsStore) {
    return { status: "unsupported", message: "The Microsoft Store manages updates for this app." };
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (latest && latest !== app.getVersion()) {
      // autoDownload is on, so it is already fetching; the restart prompt comes
      // from the update-downloaded handler above.
      return { status: "downloading", version: latest };
    }
    return { status: "up-to-date", version: app.getVersion() };
  } catch (e: unknown) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : "Couldn't reach the update server.",
    };
  }
}
