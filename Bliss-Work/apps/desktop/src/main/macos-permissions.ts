/**
 * macOS Screen Recording permission — the ONE OS-level gate the desktop
 * activity sensor has on this platform.
 *
 * ── Why this exists as its own module ────────────────────────────────────────
 * Every other file the activity sensor touches (foreground.ts,
 * activity-agent.ts) is already platform-agnostic by construction: they call
 * `get-windows` the same way on every OS, and `get-windows` itself is what
 * differs per platform underneath. This file is the one piece of GENUINELY
 * macOS-specific logic the sensor needs — checking and explaining a TCC
 * permission — and it is kept out of foreground.ts/activity-agent.ts entirely
 * so neither of those files needs an `if (platform === "darwin")` branch for
 * it. Imported ONLY from macOS-specific call sites; never reached on Windows
 * or Linux, and safe to import on either (every export here is a plain
 * function, not a top-of-module side effect) — see `status()`'s own guard.
 *
 * ── What is and is not gated ─────────────────────────────────────────────────
 * `get-windows`'s own type definitions split this precisely (see its
 * `Options` type): Screen Recording gates the window TITLE only. The
 * application/process identity (`owner.name`, `owner.path`, `owner.processId`)
 * is NOT gated by Screen Recording and is available unconditionally — macOS
 * exposes "which process is frontmost" as ordinary, ungated process
 * information, the same category of fact as `ps` output. So a macOS user who
 * has never touched System Settings still gets full "Switched to VS Code"
 * tracking; only the second line ("activity.go - BlissWork") needs this grant.
 *
 * (Accessibility, `get-windows`'s OTHER macOS permission, gates the `url`
 * field for browser tab detection. This sensor never reads that field — the
 * browser extension is the intended source for page-level browser context —
 * so Accessibility is deliberately never requested here.)
 *
 * ── Why detection here, not just "let get-windows silently return empty" ────
 * `get-windows` already degrades gracefully on its own: an unpermitted read
 * returns `title: ""`, never an exception (confirmed in its own docs). The
 * activity agent already treats an empty title as absent (see
 * activity-agent.ts's `sample()`). That alone would satisfy "does not crash",
 * but not "first-run onboarding" or "tell the person why" — a silently empty
 * title looks identical whether the window genuinely has none or the OS
 * refused to say. This module exists to tell those two cases apart for the
 * Settings screen, which is the whole point of macOS being a FIRST-CLASS
 * requirement here rather than "same as an unmapped window".
 */
import { systemPreferences } from "electron";

export type ScreenRecordingStatus =
  | "not-applicable" // not darwin, or macOS too old to gate this (pre-10.15)
  | "not-determined" // never asked; the OS prompt fires on the FIRST gated read
  | "granted"
  | "denied"
  | "restricted" // MDM/parental-controls locked; the user cannot change this themselves
  | "unknown"; // systemPreferences returned something this module does not recognise

/**
 * The current Screen Recording grant, WITHOUT triggering the OS prompt.
 *
 * `systemPreferences.getMediaAccessStatus('screen')` is main-process-only and
 * macOS-only; guarded here so calling this on Windows/Linux — which nothing
 * in this codebase does, but a future caller might by mistake — returns a
 * clean "not-applicable" instead of calling an API that does not exist there.
 *
 * KNOWN LIMITATION, stated rather than hidden: Electron's own tracker
 * (electron/electron#36722) has reported this status going stale after a
 * grant is changed in System Settings while the app is still running — it
 * does not always reflect a REVOCATION until the app restarts. This is why
 * `titleReadWorking()` below exists as a second, independent signal: this
 * function is "what macOS's permission database currently says", not
 * "whether reading a title will work right now".
 */
export async function screenRecordingStatus(): Promise<ScreenRecordingStatus> {
  if (process.platform !== "darwin") return "not-applicable";
  try {
    const raw = systemPreferences.getMediaAccessStatus("screen");
    if (raw === "not-determined" || raw === "granted" || raw === "denied" || raw === "restricted") {
      return raw;
    }
    return "unknown";
  } catch {
    // getMediaAccessStatus itself throwing is not documented as a real case,
    // but this module's entire purpose is degrading gracefully around a
    // platform permission API, so an unexpected throw here gets the same
    // treatment as every other "the OS declined to say" case.
    return "unknown";
  }
}

/**
 * The GROUND-TRUTH signal: did the last foreground read actually come back
 * with a title, on a window that plausibly has one?
 *
 * This is what activity-agent.ts's `sample()` already observes every 15
 * seconds as a side effect of normal sampling — this function does not add a
 * new read, it just names the interpretation of the SAME data the agent
 * already has, so a caller (the Settings screen) can ask "is title reading
 * actually working" without needing to understand `getMediaAccessStatus`'s
 * staleness caveat above. See `activity-agent.ts`'s `reportTitleObserved`.
 */
let lastTitleObservation: { atLeastOneWindowHadNoTitle: boolean; sampledAt: number } | null = null;

/** Called by activity-agent.ts's sample() after every foreground read — NOT
 *  exported for use elsewhere. Records only "did this read produce a title",
 *  never the title's actual text (that would duplicate a whole capture
 *  surface in a module that exists to talk about PERMISSIONS, not content). */
export function recordTitleObservation(hadTitle: boolean): void {
  if (process.platform !== "darwin") return;
  lastTitleObservation = { atLeastOneWindowHadNoTitle: !hadTitle, sampledAt: Date.now() };
}

/**
 * Best current answer to "is reading a window title actually working on this
 * machine right now", combining the OS's own status with the last real read.
 *
 * Deliberately BIASED toward what was actually observed over what
 * `getMediaAccessStatus` claims, for the staleness reason documented on
 * `screenRecordingStatus`: if the last several reads all came back with no
 * title while the frontmost app plausibly has one, that is a stronger signal
 * of "revoked, and the cached status has not caught up" than a report that
 * still says "granted".
 */
export async function titleReadWorking(): Promise<boolean> {
  if (process.platform !== "darwin") return true; // this function only means something on macOS
  const status = await screenRecordingStatus();
  if (status === "denied" || status === "restricted") return false;
  if (status !== "granted") return false; // not-determined / unknown: no OS-level grant confirmed yet
  // Granted, per the OS — but if the agent's own recent reads disagree
  // (title consistently missing), trust the observation, not the cache.
  if (lastTitleObservation && Date.now() - lastTitleObservation.sampledAt < 5 * 60_000) {
    return !lastTitleObservation.atLeastOneWindowHadNoTitle;
  }
  return true;
}

/**
 * A short, honest reason string for the Settings screen — mirrors
 * `providerUnavailableReason()` in foreground.ts, which plays the same role
 * for "app tracking is unavailable at all". This is one level narrower:
 * app-name tracking already works; this explains why the TITLE half does not.
 */
export function describeStatus(status: ScreenRecordingStatus): string {
  switch (status) {
    case "granted":
      return "Screen Recording permission granted";
    case "not-determined":
      return "Screen Recording permission has not been requested yet";
    case "denied":
      return "Screen Recording permission was denied";
    case "restricted":
      return "Screen Recording permission is restricted by a device policy";
    case "not-applicable":
      return "not applicable on this platform";
    default:
      return "Screen Recording permission status could not be determined";
  }
}

/**
 * The System Settings deep link for the Screen Recording pane, or null on a
 * platform that has none — same shape and same reasoning as
 * `locationSettingsUrl` in shared/location-settings.ts, which this
 * deliberately mirrors rather than introducing a second pattern for "open an
 * OS privacy settings page": a fixed, hard-coded, non-renderer-influenced URL
 * string, with the actual `shell.openExternal` call left to main/index.ts's
 * IPC handler (see that file's `geo:open-settings` for the precedent this
 * follows). Never call `shell.openExternal` directly from this module.
 *
 * The `x-apple.systempreferences:` scheme is confirmed stable across
 * Ventura/Sonoma/Sequoia (only the app SHELL was renamed from System
 * Preferences to System Settings; this deep-link identifier did not change).
 * macOS Tahoe reportedly relabels the pane "Screen & System Audio Recording"
 * in its UI — the identifier below is NOT independently confirmed unchanged
 * on that OS version; called out explicitly in this feature's documented
 * test gap rather than silently assumed correct.
 */
export function screenRecordingSettingsUrl(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
}
