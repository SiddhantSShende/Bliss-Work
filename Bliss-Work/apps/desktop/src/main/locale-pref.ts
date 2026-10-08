import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

/**
 * The UI language, mirrored from the renderer.
 *
 * The renderer owns the choice (localStorage `tb-locale`, see
 * packages/app/src/i18n) and pushes the effective language here over IPC — the
 * menu, tray and OS notifications are built in the MAIN process, which cannot
 * read the renderer's localStorage. This file only lets the very first menu
 * paint at launch already use the right language, before the renderer has run.
 * Same shape as notification-prefs.ts.
 */
function file(): string {
  return join(app.getPath("userData"), "locale-pref.json");
}

/** The mirrored language code, or null when none was ever recorded or the file is unreadable. */
export function readStoredLocale(): string | null {
  try {
    if (!existsSync(file())) return null;
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as { locale?: unknown };
    return typeof parsed.locale === "string" ? parsed.locale : null;
  } catch {
    return null; // a corrupt file must not brick startup
  }
}

/** Atomic temp→rename, matching notification-prefs.ts. */
export function writeStoredLocale(locale: string): void {
  const path = file();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ locale }), "utf8");
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(path + ".tmp");
    } catch {
      /* nothing more to do */
    }
  }
}
