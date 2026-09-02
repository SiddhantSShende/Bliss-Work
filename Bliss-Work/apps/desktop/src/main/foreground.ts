/**
 * The native foreground-window provider, and the "is the bare desktop showing"
 * reading that the floating task notes need.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * Two callers, one native dependency:
 *
 *   1. The activity agent records WHICH application the user is working in.
 *   2. The desktop task notes need to know when the user is looking at the BARE
 *      DESKTOP, because that is when a desktop widget belongs on screen.
 *
 * Both need the OS asked for its frontmost window — Electron reports focus
 * changes for its OWN windows only, and there is no event for "some other
 * application came to the front". `get-windows` ships prebuilt helper binaries
 * that answer that question; this module owns loading it, so there is exactly
 * one copy and one place that knows why it might be missing.
 *
 * ── Why this came back, and what is different ────────────────────────────────
 * This reading used to drive the notes, was removed, and is now restored —
 * because removing it took the feature with it. Without it the only signal left
 * was "does BlissWork have keyboard focus", so a note could not be on screen
 * unless the app was frontmost: minimise BlissWork, or press Win+D, and every
 * pinned task vanished. A task note is a DESKTOP widget; the desktop is exactly
 * where it is supposed to be.
 *
 * The bug that justified removing it was real, though, and is fixed here rather
 * than reintroduced: the old version defaulted `safe` to TRUE and stayed there
 * when the native module failed to load (a packaged build, a mismatched Electron
 * ABI, a Wayland session), which left the notes globally always-on-top over
 * other applications — the one thing this feature promises never to do.
 *
 * So this reading now FAILS CLOSED: unknown means "not the desktop". It is only
 * ever an ADDITIONAL reason to show a note, OR-ed in ./app-active with
 * BlissWork's own focus state. A machine that cannot answer therefore degrades
 * to "notes follow the app", never to "notes cover your work".
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

/**
 * How often the foreground application is sampled.
 *
 * This IS the delay between the desktop coming into view and a note reacting.
 * Electron fires focus/blur for BlissWork's own windows, and ./app-active
 * carries that half with no lag at all — this poll exists solely for the
 * transitions Electron cannot see, above all "everything was minimised and the
 * bare desktop is now in front". Four short-lived samples a second is not a
 * meaningful cost for as long as the app runs.
 */
const POLL_MS = 250;

/**
 * Whether a note may be on screen given what the OS says is frontmost.
 *
 * Pure and platform-parameterised so it can be tested without an OS in front of
 * you. This answers only the DESKTOP half of the question; ./app-active ORs it
 * with BlissWork's own focus state.
 */
export function isSafeToFloat(
  active: ForegroundWindow | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // BlissWork's own windows (the main window, a meeting window, …) share this
  // process — checked first and identically on every platform, since it is
  // not a platform assumption at all, unlike the desktop-detection below.
  if (active?.owner?.processId === process.pid) return true;

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
  // Linux gets its desktop behaviour from `type: "desktop"` on the window itself
  // (see createStickyWindow), which parks the note at the BOTTOM of the real
  // window stack. It is therefore never in anybody's way and never has to be
  // taken away — so there is nothing for this reading to add.
  return true;
}

/**
 * Best current answer.
 *
 * Starts FALSE and stays false on a build or a session that cannot answer. This
 * is the inversion of the old default, and the whole reason this module is safe
 * to have back: "unknown" must never mean "put the note over their work". The
 * cost of failing closed is only that a note waits for BlissWork's own focus —
 * ./app-active still shows it — which is a degradation nobody can be harmed by.
 */
let desktopShowing = false;
let timer: NodeJS.Timeout | null = null;
// Set synchronously on entry, because the provider load below is awaited and a
// timer-only guard would let two calls both get past it and leave one interval
// running forever with nothing holding its handle.
let started = false;
const listeners = new Set<(showing: boolean) => void>();

/** Whether the OS says the bare desktop (or one of our own windows) is in front. */
export function isDesktopShowingNow(): boolean {
  return desktopShowing;
}

/** Subscribe to changes. Returns an unsubscribe. */
export function onDesktopShowingChange(cb: (showing: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function set(next: boolean): void {
  if (next === desktopShowing) return;
  desktopShowing = next;
  for (const cb of listeners) cb(next);
}

/**
 * How many consecutive empty reads in a row mean "this is a stub, not a
 * momentary gap" — see the block comment on `sample()` below for why this
 * exists at all. At POLL_MS=250ms, 8 ticks is exactly 2s: comfortably longer
 * than any real transition between windows, short enough that a genuinely
 * broken build is reported within a couple of seconds of launch.
 */
const STUB_SUSPECT_TICKS = 8;
let consecutiveEmptyReads = 0;

async function sample(win: GetWindows): Promise<void> {
  let active: ForegroundWindow | undefined;
  try {
    active = await win.activeWindow();
  } catch {
    // A transient failure to read the foreground window is not information.
    // Holding the last answer keeps the notes from flickering on and off; the
    // next tick is a quarter of a second away.
    return;
  }
  set(isSafeToFloat(active));

  // A LOADED-BUT-BROKEN provider — the module imported without throwing, but
  // the platform-specific native binding it needs was never bundled (the
  // 0.2.2/0.2.3 incident: get-windows shipped with no win32 prebuild). Its own
  // loader does not throw in that case; it silently returns a stub whose
  // getActiveWindow() always resolves undefined — see get-windows/lib/windows.js.
  // That failure mode is invisible to loadProvider()'s try/catch above (nothing
  // ever throws) and was, before this, invisible to the user too: Settings'
  // "application tracking isn't available" banner is driven by whether the
  // module LOADED, not by whether it actually answers anything.
  //
  // On win32/darwin — the only platforms that ever reach this function, since
  // Linux never calls loadProvider() at all (see startDesktopWatch) — there is
  // essentially always SOME window in front, even if it's just the desktop
  // shell. A real provider basically never returns undefined many polls in a
  // row; a stub always does. Once tripped this does not un-trip: a provider
  // that is genuinely a no-op stays one for the life of the process, and the
  // point is to tell the user that once, reliably, not to chase a flapping
  // signal.
  if (active === undefined) {
    consecutiveEmptyReads++;
    if (consecutiveEmptyReads === STUB_SUSPECT_TICKS && providerError === null) {
      providerError = "the native window-reading module loaded but never returns anything (likely built for the wrong platform)";
      console.warn(
        "[desktop-watch] provider loaded but appears to be a no-op stub; task notes will follow app focus only:",
        providerError,
      );
    }
  } else {
    consecutiveEmptyReads = 0;
  }
}

/**
 * Begin watching. Safe to call twice.
 *
 * Linux answers TRUE once and never polls: `type: "desktop"` already keeps the
 * note at the bottom of the stack there, so it is never covering anything and
 * there is nothing to watch for.
 */
export async function startDesktopWatch(): Promise<void> {
  if (started) return;
  started = true;
  if (process.platform === "linux") {
    set(true);
    return;
  }
  const win = await loadProvider();
  if (!win) {
    // Said out loud because it changes the feature's behaviour on this machine:
    // notes will follow BlissWork's focus instead of resting on the desktop.
    // That is the safe direction, but someone reading a "my notes disappear
    // when I minimise" report needs to find this line.
    console.warn(
      "[desktop-watch] unavailable; task notes will follow app focus only:",
      providerUnavailableReason(),
    );
    return;
  }
  timer = setInterval(() => void sample(win), POLL_MS);
  // Answer once immediately rather than leaving the first tick to the default.
  void sample(win);
}

export function stopDesktopWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/**
 * Re-sample immediately instead of waiting for the next poll tick.
 *
 * Electron fires `browser-window-blur` / `browser-window-focus` the instant one
 * of BlissWork's own windows gains or loses OS focus. Those are the two
 * transitions where the poll's lag is most visible, so ./app-active pokes this
 * from them and the note reacts at once rather than up to POLL_MS later.
 */
export function pokeDesktopWatch(): void {
  if (!timer) return;
  void loadProvider().then((win) => {
    if (win) void sample(win);
  });
}
