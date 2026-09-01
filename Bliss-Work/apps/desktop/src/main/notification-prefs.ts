import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

/**
 * "Desktop notifications" preference, mirrored from the renderer.
 *
 * The renderer keeps its own copy in localStorage (see
 * packages/app/src/lib/notificationPrefs.ts) and pushes it here over IPC —
 * once on Settings mount and again on every toggle — because `notifier.ts`'s
 * `raise()` runs from the MAIN process (so popups still fire while the window
 * is minimised or in the tray) and main has no access to the renderer's
 * localStorage at all. This file is the mirror `maybeNotify` reads
 * synchronously before raising a popup.
 *
 * Defaults to enabled, matching notificationPrefs.ts's own default, so a
 * fresh install (or one that predates this file) behaves exactly as it did
 * before the preference existed, until the renderer's first sync arrives.
 */
let filePath = "";
let enabled = true;
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    filePath = join(app.getPath("userData"), "notification-prefs.json");
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { desktopEnabled?: unknown };
      enabled = parsed.desktopEnabled !== false;
    }
  } catch {
    // A corrupt file must not brick startup, and defaulting to enabled matches
    // the "never silently opt out" behaviour of a fresh install.
    enabled = true;
  }
}

/** Atomic temp→rename, matching activity-state.ts / sticky-state.ts. */
function flush(): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ desktopEnabled: enabled }), "utf8");
    renameSync(tmp, filePath);
  } catch {
    try {
      unlinkSync(filePath + ".tmp");
    } catch {
      /* nothing more to do */
    }
  }
}

export function getDesktopEnabled(): boolean {
  ensureLoaded();
  return enabled;
}

export function setDesktopEnabled(next: boolean): void {
  ensureLoaded();
  enabled = next;
  flush();
}
