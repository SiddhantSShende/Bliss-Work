/**
 * The native foreground-window provider, loaded once and shared.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * The activity agent records WHICH application the user is working in, which
 * needs the OS to be asked for its frontmost window — Electron reports focus
 * changes for its OWN windows only, and there is no event for "some other
 * application came to the front". `get-windows` ships prebuilt helper binaries
 * that answer that question; this module owns loading it, so there is exactly
 * one copy and one place that knows why it might be missing.
 *
 * ── What this is NO LONGER for ───────────────────────────────────────────────
 * This file used to also drive the floating task notes: a 1 s poll asked the
 * OS what was frontmost and toggled `alwaysOnTop` on the notes to match. That
 * mechanism is gone. It defaulted to "safe to float" and STAYED there whenever
 * the native module failed to load (a packaged build, a mismatched Electron
 * ABI, a Wayland session), which left the notes globally always-on-top over
 * other applications — the one thing the feature promises never to do. Notes
 * are now Electron child windows of the main window, shown and hidden from
 * BlissWork's own focus lifecycle, and need no OS reading at all. See
 * ./app-active and createStickyWindow in ./windows.
 */
export interface ForegroundWindow {
  title?: string;
  owner?: { name?: string; path?: string; processId?: number };
}

export type GetWindows = { activeWindow: () => Promise<ForegroundWindow | undefined> };

let provider: GetWindows | null = null;
let providerChecked = false;
let providerError: string | null = null;

/**
 * Resolve the native foreground-window provider, once.
 *
 * `get-windows` ships PREBUILT helper binaries rather than compiling on install,
 * which is the property that makes it usable here at all. Wayland is excluded
 * outright: GNOME and KDE deliberately do not expose the active window, so the
 * honest answer is "unsupported on this session" rather than silently reporting
 * nothing and letting an admin read that as "they did no work".
 */
export async function loadProvider(): Promise<GetWindows | null> {
  if (providerChecked) return provider;
  providerChecked = true;
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
    providerError = "Wayland does not expose the active window";
    return null;
  }
  try {
    // `get-windows` IS a declared dependency and is expected to be present — it
    // is the real foreground-window provider, not a stand-in for one. The
    // specifier stays a VARIABLE so the bundler leaves it as a runtime import
    // (it ships a native addon and a platform helper binary that cannot be
    // inlined), and so a load failure degrades instead of refusing to boot.
    const specifier = "get-windows";
    provider = (await import(/* @vite-ignore */ specifier)) as GetWindows;
  } catch {
    // Reached when the native addon did not load — a build packaged without the
    // dependency, or one rebuilt for the wrong Electron ABI. Reported as-is to
    // Settings rather than silently pretending the reading is unavailable for
    // some benign reason.
    provider = null;
    providerError = "app tracking is unavailable in this build";
  }
  return provider;
}

/** Why the provider is unavailable, for the Settings screen to say out loud. */
export function providerUnavailableReason(): string | null {
  return providerError;
}
