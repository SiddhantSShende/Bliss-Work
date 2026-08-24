import { app, BrowserWindow, globalShortcut, type WebContents } from "electron";
import * as activityAgent from "./activity-agent";

/**
 * Screenshot deterrence, detection, and an audit trail.
 *
 * ── What this can and cannot do ──────────────────────────────────────────────
 *
 * Be precise about this, because the feature's name overpromises. A screenshot
 * is taken by the operating system's compositor, from pixels that have already
 * been decrypted and drawn on the user's own machine. There is no server-side
 * control: a backend cannot see the framebuffer, cannot see the keyboard, and
 * cannot un-render pixels. Nothing here — or anywhere — stops a phone camera.
 *
 * What IS enforceable:
 *
 *   • `setContentProtection(true)` asks the OS to exclude the window from
 *     capture. Windows honours it (WDA_EXCLUDEFROMCAPTURE) and macOS honours it
 *     (NSWindowSharingNone): the captured region comes out black. On Linux/X11
 *     it is a documented NO-OP, and Linux is what the AppImage and .deb builds
 *     run on — so on the platform this repo builds natively, this is deterrence
 *     and detection only.
 *   • Intercepting the PrintScreen key while we hold focus. This covers one key
 *     on one keyboard. It does NOT cover Win+Shift+S, the Snipping Tool,
 *     macOS's Cmd+Shift+3/4/5 (OS-reserved, and unregistrable by an app),
 *     gnome-screenshot, Flameshot, Spectacle, or ShareX.
 *
 * So: the window is excluded from capture where the OS allows it, an attempt we
 * can see is refused and reported to the user, and the attempt is recorded.
 * That is the honest deliverable. `docs/SECURITY.md` says the same thing to
 * anyone evaluating the control, and the product copy must not claim more.
 *
 * ── Why the shortcut is registered on focus and released on blur ─────────────
 *
 * `globalShortcut` is genuinely global: a registration held for the process
 * lifetime would take PrintScreen away from every other application for as long
 * as BlissWork sits in the tray, which it does all day. Binding the
 * registration to our own focus keeps the key ours only while the protected
 * content is actually on screen.
 */

/**
 * Notified on every detected attempt, so main can toast the renderer.
 *
 * `recorded` says whether the attempt already reached the activity record here.
 * It has not, for anyone who declined the activity agent — which is most
 * people — and the renderer reports those itself so the control still leaves a
 * server-side trace. Passing the fact along is what stops it being recorded
 * twice for everyone else.
 */
type AttemptListener = (source: string, recorded: boolean) => void;

let notify: AttemptListener = () => {};

/** Coalesce bursts: PrintScreen auto-repeats while held, and a user mashing it
 *  should produce one warning, not thirty. Also bounds the telemetry writes. */
const ATTEMPT_COALESCE_MS = 3_000;
let lastAttemptAt = 0;

/** PrintScreen chords we can actually claim. macOS's capture chords are
 *  reserved by the OS and `register` fails on them, which is handled below. */
const CAPTURE_ACCELERATORS = ["PrintScreen", "Alt+PrintScreen", "CommandOrControl+PrintScreen"];

let registered = false;

/**
 * Record and announce one attempt.
 *
 * Both effects are best-effort and neither may throw into an input handler:
 * telemetry is gated on the user's activity-agent consent (see below) and the
 * renderer may be mid-reload.
 */
function onAttempt(source: string): void {
  const now = Date.now();
  if (now - lastAttemptAt < ATTEMPT_COALESCE_MS) return;
  lastAttemptAt = now;

  console.warn(`[security] screenshot attempt blocked (${source})`);

  // Recorded here ONLY for users who consented to the activity agent and paired
  // a device — activityAgent.recordScreenshotAttempt is a no-op otherwise. That
  // is deliberate: the alternative is writing MONITORING records about people
  // who explicitly declined monitoring, which is exactly what the consent notice
  // exists to prevent.
  //
  // It runs before the notify below so the renderer can be told whether it still
  // needs to report the attempt through its own session beacon. That beacon is
  // ordinary session telemetry the client already sends, not the activity agent,
  // so declining monitoring costs the user their app-usage record — not the
  // security record of a refused capture.
  let recorded = false;
  try {
    recorded = activityAgent.recordScreenshotAttempt();
  } catch (err) {
    console.error("[security] failed to record screenshot attempt", err);
  }

  try {
    notify(source, recorded);
  } catch (err) {
    console.error("[security] failed to notify renderer of screenshot attempt", err);
  }
}

/** Claim the capture keys. Called when one of our windows takes focus. */
function acquireShortcuts(): void {
  if (registered) return;
  registered = true;
  for (const accel of CAPTURE_ACCELERATORS) {
    try {
      // `register` returns false when the OS reserves the chord or another app
      // already holds it. That is an expected outcome on macOS, not an error —
      // we simply do not get to see those attempts.
      if (!globalShortcut.register(accel, () => onAttempt(accel))) {
        console.info(`[security] could not claim ${accel} (reserved or already held)`);
      }
    } catch (err) {
      console.warn(`[security] failed to register ${accel}`, err);
    }
  }
}

/** Give the capture keys back to the rest of the desktop. */
function releaseShortcuts(): void {
  if (!registered) return;
  registered = false;
  for (const accel of CAPTURE_ACCELERATORS) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* already gone — nothing to release */
    }
  }
}

/**
 * Catch capture chords typed INTO one of our windows.
 *
 * This is the second layer, and it covers what `globalShortcut` cannot: the
 * macOS chords the OS refuses to hand over. We cannot stop the OS acting on
 * Cmd+Shift+4 — but we can see it and say so, which is the difference between
 * a silent capture and a recorded one.
 */
export function watchCaptureKeys(wc: WebContents, label: string): void {
  wc.on("before-input-event", (event, input) => {
    const chord = captureChordOf(input);
    if (!chord) return;
    // preventDefault stops the keystroke reaching our own page. It does NOT
    // stop the OS-level capture on macOS, which happens before we see it.
    event.preventDefault();
    onAttempt(`${label}:${chord}`);
  });
}

/** The subset of an Electron `Input` this predicate needs. Declared structurally
 *  so the logic can be tested without constructing a real Electron input. */
export interface CaptureKeyInput {
  type: string;
  key: string;
  meta?: boolean;
  shift?: boolean;
}

/**
 * Name the screen-capture chord this keystroke represents, or null.
 *
 * Pure, and exported, so the chord table is testable without an Electron
 * window — the same reason shared/deeplink.ts and shared/external-url.ts are
 * split out from their callers.
 */
export function captureChordOf(input: CaptureKeyInput): string | null {
  if (input.type !== "keyDown") return null;
  const key = input.key;

  // Chromium reports the key as "PrintScreen"; some Linux keymaps send "Print".
  if (key === "PrintScreen" || key === "Print") return "PrintScreen";

  // macOS: Cmd+Shift+3 (whole screen), 4 (region), 5 (capture toolbar).
  if (input.meta && input.shift && (key === "3" || key === "4" || key === "5")) {
    return `Cmd+Shift+${key}`;
  }

  return null;
}

/**
 * Exclude a window from OS screen capture.
 *
 * Re-applied on `show` because Windows drops the capture affinity when a window
 * is hidden and re-shown, which the tray's hide-on-close does on every close.
 */
export function applyContentProtection(win: BrowserWindow, label: string): void {
  const protect = () => {
    try {
      win.setContentProtection(true);
    } catch (err) {
      console.warn(`[security] setContentProtection failed (${label})`, err);
    }
  };
  protect();
  win.on("show", protect);
}

/**
 * Wire the focus-scoped shortcut registration. Called once at startup.
 *
 * `onDetected` is how main forwards the attempt to the renderer's toast; see
 * the `security:screenshot-blocked` channel.
 */
export function initScreenshotGuard(onDetected: AttemptListener): void {
  notify = onDetected;

  if (process.platform === "linux") {
    // Say it once, at startup, so nobody debugging a Linux build wonders why
    // the black rectangle never appears.
    console.info(
      "[security] content protection is a no-op on Linux/X11 — screenshots of this window will succeed",
    );
  }

  // These fire for every window we own, including the sticky notes — which is
  // what we want, since the notes render task content too.
  app.on("browser-window-focus", acquireShortcuts);

  // Moving focus BETWEEN our own windows (main → sticky note) fires blur before
  // the next focus, so releasing synchronously would unregister and re-register
  // on every internal hop. Defer one turn and re-check: if any of our windows
  // still holds focus, the app never actually lost it.
  app.on("browser-window-blur", () => {
    setImmediate(() => {
      if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())) return;
      releaseShortcuts();
    });
  });

  // A claimed global shortcut outlives a crash-free quit only if we let it, and
  // `will-quit` is the last point at which Electron guarantees we can.
  app.on("will-quit", releaseShortcuts);
}

