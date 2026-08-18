/**
 * Screen-capture detection in the PAGE.
 *
 * ── What a browser can and cannot do ─────────────────────────────────────────
 *
 * Be precise, because the feature's name overpromises. A screenshot is taken by
 * the operating system's compositor, from pixels already decrypted and drawn on
 * the user's own machine. No web page can stop that, and no server can either —
 * a backend cannot see the framebuffer, cannot see the keyboard, and cannot
 * un-render pixels. Nothing anywhere stops a phone camera.
 *
 * What a page CAN do is notice the capture keys that are delivered to it, refuse
 * them, say so, and tell the server. That is what this module is: detection and
 * an honest warning, not prevention.
 *
 * The desktop app does strictly more — `setContentProtection` asks Windows and
 * macOS to exclude the window from capture entirely, and the main process sees
 * chords a page never receives (see apps/desktop/src/main/screenshot-guard.ts).
 * So this watcher is installed only where that host is absent; where it exists,
 * main is the detector and the page merely renders what it reports.
 *
 * NOT covered here, and not coverable: Win+Shift+S and the Snipping Tool (the
 * Windows key is intercepted by the shell and never reaches the page),
 * gnome-screenshot / Flameshot / Spectacle / ShareX, and any capture started
 * from another application. macOS's Cmd+Shift+3/4/5 IS seen, because the
 * keystroke is delivered to the focused page even though the OS acts on it too —
 * which is the difference between a silent capture and a recorded one.
 */

/** The exact wording the product promises on a detected attempt. */
export const SCREENSHOT_BLOCKED_MESSAGE =
  "Screenshot attempt detected. Screenshots are not allowed.";

/** Coalesce bursts: PrintScreen auto-repeats while held, and a user leaning on
 *  it should produce one warning, not thirty. Also bounds what we report. */
export const ATTEMPT_COALESCE_MS = 3_000;

/** The subset of a KeyboardEvent this predicate reads. Declared structurally so
 *  the chord table is testable without synthesising DOM events. */
export interface CaptureKeyEvent {
  key: string;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Name the screen-capture chord this keystroke represents, or null.
 *
 * Mirrors captureChordOf in the desktop main process. The two are separate
 * because neither host can import the other's module, and they are deliberately
 * kept in step: an attempt that the desktop reports as "PrintScreen" and the web
 * reports as something else would split one control into two in the record.
 */
export function captureChordOf(e: CaptureKeyEvent): string | null {
  // Chromium reports "PrintScreen"; some Linux keymaps send "Print".
  if (e.key === "PrintScreen" || e.key === "Print") return "PrintScreen";

  // macOS: Cmd+Shift+3 (whole screen), 4 (region), 5 (capture toolbar).
  if (e.metaKey && e.shiftKey && (e.key === "3" || e.key === "4" || e.key === "5")) {
    return `Cmd+Shift+${e.key}`;
  }
  return null;
}

/**
 * Watch for capture chords typed into this page. Returns an unsubscribe fn.
 *
 * Listens in the CAPTURE phase so the attempt is seen before any component's
 * own key handling, and calls preventDefault — which stops the keystroke
 * reaching the page (and any browser-level binding), but does NOT stop the
 * operating system, which has already acted by the time we are called.
 */
export function watchCaptureKeys(onAttempt: (chord: string) => void): () => void {
  if (typeof window === "undefined") return () => {};

  let lastAt = 0;
  const onKeyDown = (e: KeyboardEvent) => {
    const chord = captureChordOf(e);
    if (!chord) return;
    e.preventDefault();

    const now = Date.now();
    if (now - lastAt < ATTEMPT_COALESCE_MS) return;
    lastAt = now;
    onAttempt(chord);
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
