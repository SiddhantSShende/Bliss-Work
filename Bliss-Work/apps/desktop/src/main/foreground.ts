/**
 * Which application the user is actually looking at, and what that means for the
 * desktop task notes.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A task note is pinned to the DESKTOP: visible when the desktop is, and never
 * over the top of whatever someone is working in. Electron can only express that
 * directly on Linux, where `type: "desktop"` maps to _NET_WM_WINDOW_TYPE_DESKTOP
 * and the window manager keeps the window at the bottom of the stack for real.
 *
 * The other two platforms cannot:
 *   * Windows supports only `type: "toolbar"` — "desktop" is silently ignored,
 *     and there is no API to lower a window in the z-order. A note therefore
 *     appears ON TOP of the front application when it is first shown.
 *   * macOS does support `type: "desktop"`, but such a window "will not receive
 *     focus, keyboard or mouse events" — which would leave Acknowledge, Ignore
 *     and Complete dead, and those buttons are the entire point of the note.
 *
 * So on Windows and macOS the notes are SHOWN while the desktop is in front and
 * HIDDEN while any other application is, which is the same thing to look at and
 * keeps every button working. Linux keeps the real desktop layer.
 *
 * ── Why polling ──────────────────────────────────────────────────────────────
 * Electron reports focus changes for its OWN windows only; there is no event for
 * "some other application came to the front". The foreground window has to be
 * asked for, and `get-windows` is the same prebuilt provider the activity agent
 * already uses — loaded here once and shared, rather than a second copy.
 */
export interface ForegroundWindow {
  title?: string;
  owner?: { name?: string; path?: string; processId?: number };
}

export type GetWindows = { activeWindow: () => Promise<ForegroundWindow | undefined> };

/**
 * How often the foreground application is sampled.
 *
 * This IS the delay between switching to another app and the note getting out of
 * its way, so it wants to be short. It is not shorter because on macOS every
 * sample runs a helper binary — a second is unnoticeable to a person and cheap
 * enough to run for as long as the app does.
 */
const POLL_MS = 1_000;

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

/**
 * Whether a foreground-window reading means "the desktop is what the user is
 * looking at".
 *
 * Every platform assumption in this feature is in this one function, on purpose:
 * it is the part that cannot be verified without the actual operating system in
 * front of you, so it is small and pure rather than spread through the window
 * code.
 */
export function isDesktopExposed(
  active: ForegroundWindow | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    // The Windows desktop IS a window — Progman, titled "Program Manager" — and
    // it becomes the foreground window both when the desktop is clicked and when
    // Show Desktop (Win+D) minimises everything.
    //
    // Matched on the TITLE rather than on explorer.exe, which is the distinction
    // that matters: File Explorer windows are explorer.exe too, and a file
    // browser is another application to stay out of the way of.
    return active?.title === "Program Manager";
  }
  if (platform === "darwin") {
    // The macOS desktop belongs to Finder and is not a window of its own, so it
    // reads as "Finder frontmost, with no titled window". A Finder WINDOW in
    // front is a file browser — another application — and it reports its folder
    // name, which is what keeps the two apart.
    return active?.owner?.name === "Finder" && !active?.title;
  }
  // Linux does not need this: the note really is at the bottom of the stack, so
  // it is never in the way and never has to be taken away.
  return true;
}

/**
 * Best current answer, and the default before anything is known.
 *
 * Starts TRUE, and stays true on a platform or a build that cannot answer:
 * degrading to "the notes behave as they did before" is a far better failure
 * than a native module quietly making the pinned tasks disappear for good.
 */
let exposed = true;
let timer: NodeJS.Timeout | null = null;
// Set synchronously on entry, because the provider load below is awaited and a
// timer-only guard would let two calls both get past it and leave one interval
// running forever with nothing holding its handle.
let started = false;
const listeners = new Set<(exposed: boolean) => void>();

export function isDesktopCurrentlyExposed(): boolean {
  return exposed;
}

/** Subscribe to changes. Returns an unsubscribe. */
export function onDesktopExposureChange(cb: (exposed: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function set(next: boolean): void {
  if (next === exposed) return;
  exposed = next;
  for (const cb of listeners) cb(next);
}

async function sample(win: GetWindows): Promise<void> {
  let active: ForegroundWindow | undefined;
  try {
    active = await win.activeWindow();
  } catch {
    // A transient failure to read the foreground window is not information.
    // Holding the last answer keeps the notes from flickering on and off; the
    // next tick is a second away.
    return;
  }
  set(isDesktopExposed(active));
}

/**
 * Begin watching. Safe to call twice; a no-op where it is not needed.
 *
 * Not started on Linux: `type: "desktop"` already keeps the note behind
 * everything there, and hiding it as well would take away a note that was not in
 * anybody's way to begin with.
 */
export async function startDesktopWatch(): Promise<void> {
  if (started) return;
  if (process.platform === "linux") return;
  started = true;
  const win = await loadProvider();
  if (!win) {
    // The notes stay visible, exactly as they behaved before this existed. Said
    // out loud because it means the "never covers another app" promise is not
    // being kept on this machine, which someone reading a bug report needs.
    console.warn(
      "[desktop-watch] unavailable; task notes may overlap other apps:",
      providerError,
    );
    return;
  }
  timer = setInterval(() => void sample(win), POLL_MS);
  // Answer once immediately rather than leaving the first second to the default.
  void sample(win);
}

export function stopDesktopWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
