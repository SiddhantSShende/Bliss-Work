import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

/**
 * "Protect BlissWork from screenshots and screen sharing" preference.
 *
 * Controls whether `setContentProtection(true)` (screenshot-guard.ts) is
 * applied to our windows. Persisted the same way as notification-prefs.ts
 * (atomic temp→rename JSON in userData) so the main process can read it at
 * startup, before any window — including a sticky note restored from the
 * previous session — is created.
 *
 * Defaults to enabled: a fresh install, and any installation that predates
 * this preference, must keep today's protection behaviour rather than
 * silently opting a user out of it.
 */
let filePath = "";
let enabled = true;
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    filePath = join(app.getPath("userData"), "screenshot-protection-prefs.json");
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { protectionEnabled?: unknown };
      enabled = parsed.protectionEnabled !== false;
    }
  } catch {
    enabled = true;
  }
}

/** Atomic temp→rename, matching notification-prefs.ts / sticky-state.ts. */
function flush(): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ protectionEnabled: enabled }), "utf8");
    renameSync(tmp, filePath);
  } catch {
    try {
      unlinkSync(filePath + ".tmp");
    } catch {
      /* nothing more to do */
    }
  }
}

export function getProtectionEnabled(): boolean {
  ensureLoaded();
  return enabled;
}

export function setProtectionEnabled(next: boolean): void {
  ensureLoaded();
  enabled = next;
  flush();
}
