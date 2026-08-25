import { win32, posix } from "node:path";
import { powerMonitor } from "electron";
import { browserSlug, resolveApp } from "@taskboard/shared";
import { isActive, getState } from "./activity-state";
// Shared with the desktop-note watcher: one provider, loaded once, so the two
// features cannot disagree about whether app tracking is available.
import { loadProvider, providerUnavailableReason } from "./foreground";
// macOS-only in effect (every export is a platform-guarded no-op elsewhere) —
// see macos-permissions.ts's own docstring for why this lives in its own file
// rather than as branches inside this one.
import { recordTitleObservation, screenRecordingStatus, describeStatus } from "./macos-permissions";

/**
 * The desktop activity agent — BlissWork's desktop-level source of truth for
 * which application is in front.
 *
 * Two capabilities, deliberately separated because one is free and the other is
 * not:
 *
 *   1. PRESENCE AT THE MACHINE — `powerMonitor` idle time, screen lock/unlock,
 *      suspend/resume. Built into Electron, zero dependencies, every platform,
 *      no OS permission. This is a strictly better idle signal than the
 *      renderer's input listeners, which cannot see anything once the window
 *      loses focus.
 *
 *   2. FOREGROUND APPLICATION — which app is in front, by name, process and
 *      (where the platform exposes it) window title. Electron has no API for
 *      this, so it needs a native module. Loaded dynamically: if it is not
 *      installed the agent still runs with capability (1) and reports the
 *      absence, rather than failing to start. That keeps the dependency
 *      optional, which matters because `desktop-builder` cross-builds Windows
 *      under Wine and cannot compile a node-gyp addon.
 *
 * Window titles ARE read, as of the unified activity model — but only with the
 * same explicit, versioned consent that gates everything else this file does
 * (see activity-state.ts's `consentedVersion`, and DeviceActivitySettings.tsx's
 * disclosure). They travel in `detail`, the encrypted-at-rest half of the row,
 * same as a URL or a message preview — never in `targetId`, which stays the
 * coarse, plaintext, aggregatable app name every rollup already groups by.
 *
 * Everything here runs in the MAIN process and posts straight to the server with
 * a pairing token. Sampled data never passes through the renderer, so an XSS in
 * the web layer cannot read it and closing every window does not stop it.
 *
 * ── Why one polling loop, not a separate process or a second sampler ────────
 * The foreground window has to be POLLED — Electron/Win32 expose no event for
 * "some other application came to the front" (see foreground.ts's own note on
 * why the desktop-note watcher polls too) — so an event-driven design is not
 * available here regardless of process boundary. Splitting this into a
 * standalone agent process would duplicate the pairing-token auth, the queue/
 * flush/backoff logic, and the consent gate that already exist in this file,
 * for a mechanism (setInterval) that does not need its own process to run
 * safely; this already survives every renderer window closing, which is the
 * property a separate process would exist to provide.
 */

/** How often the foreground app is sampled. 15s is fine-grained enough to see a
 *  context switch and coarse enough to be invisible in CPU terms. */
const SAMPLE_MS = 15_000;
/** How often a batch is posted. */
const FLUSH_MS = 60_000;
/** OS-level idle threshold, matching the web client's. */
const IDLE_AFTER_S = 300;
/** Never let the buffer grow without bound if the server is unreachable. */
const MAX_QUEUED = 500;

interface AgentEvent {
  action: string;
  category: "app" | "system";
  occurredAt: string;
  targetKind?: string;
  targetId?: string;
  durationMs?: number;
  /**
   * Encrypted per-org at rest by telemetry-svc. Formalized keys — see
   * packages/shared/src/types/activity.ts's `ActivityDetail`:
   *   from     the application the user switched OUT of to reach this one.
   *   title    the window title, read at the moment the span opened. Absent
   *            when the platform would not give one (a window with no title,
   *            or a foreground reading that failed — see `sample`).
   *   process  the OS process/executable basename, when it differs from the
   *            resolved app name already carried in `targetId`.
   *   browser  which browser this span is, when the app is a recognised one —
   *            lets the timeline read "Switched to Chrome" without the desktop
   *            sensor treating any one browser specially (see `browserSlug`).
   */
  detail?: Record<string, string>;
}

/**
 * How the timeline says "they were in BlissWork itself".
 *
 * Must match BLISSWORK_DESTINATION in packages/shared. Not imported: this file
 * runs in the Electron MAIN process, which is bundled separately and
 * deliberately carries no dependency on the web package.
 */
const SELF = "BlissWork";

/**
 * Whether a foreground reading is BlissWork's own window.
 *
 * Matched on the name containing "blisswork" rather than on an exact string,
 * because the three platforms report the packaged app differently — the
 * executable on Windows, the bundle display name on macOS, the WM class on
 * Linux — and the release, beta and development builds differ again. The same
 * loose test is already what the analytics tab uses to exclude BlissWork from
 * "time outside BlissWork" (see MemberAnalytics.tsx), so the two agree by
 * construction rather than by coincidence.
 */
function isSelf(appName: string): boolean {
  return /blisswork/i.test(appName);
}

let telemetryBase = "";
let queue: AgentEvent[] = [];
let sampleTimer: NodeJS.Timeout | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let current: {
  app: string;
  since: number;
  from: string | null;
  title: string | null;
  process: string | null;
  browser: string | null;
} | null = null;
let idleSince: number | null = null;
function push(e: AgentEvent): void {
  queue.push(e);
  // Drop the OLDEST: after a long offline stretch the recent minutes are the
  // ones anyone looking at the timeline wants.
  if (queue.length > MAX_QUEUED) queue = queue.slice(-MAX_QUEUED);
}

function stamp(): string {
  return new Date().toISOString();
}

/**
 * The filename component of a path, whichever style it was written in.
 *
 * `get-windows` reports `owner.path` in the host OS's native style — backslash
 * on Windows, forward slash on macOS/Linux — and Node's platform-default
 * `path.basename` only parses the style matching the process it runs in. Tried
 * against BOTH parsers rather than switched on `process.platform`, so this
 * agrees with itself under a cross-platform test host the same way it would in
 * a real packaged build.
 */
function basename(path: string): string {
  const win = win32.basename(path);
  return win !== path ? win : posix.basename(path);
}

/**
 * Close the open foreground span and record it.
 *
 * The span carries WHERE THE USER CAME FROM as well as where they went, which
 * is what turns a list of things someone had open into a record of what they
 * did: `app.focus` for VS Code preceded by BlissWork is "switched from
 * BlissWork to VS Code at 10:42, and stayed six minutes".
 *
 * Deliberately the SAME row rather than a switch event beside it. The span
 * already lands at the moment of the switch (`occurredAt` is backdated to when
 * the app came to the front) and already carries the duration, so a second row
 * would say the same thing twice, double the volume of the app category, and
 * give the two copies a way to disagree. `from` is absent on the first span
 * after the agent starts, and on every row written before this existed — the
 * timeline falls back to "Used VS Code" for those rather than guessing.
 *
 * `from`/`title`/`process`/`browser` go in `detail` because that is the
 * encrypted-at-rest half of the row. `targetId` stays exactly what it was —
 * the destination app name, in the clear — so every existing rollup that
 * groups by it is untouched.
 *
 * The title is the one read at the moment the span OPENED (see `sample`), not
 * re-read on every tick — switching tabs inside the same application changes
 * the window title without changing which application is in front, and this
 * agent's unit is the application span. A title that drifts mid-span (a
 * document being renamed, a browser tab changing) is therefore not chased;
 * the alternative — a new row every time a title string changes — would
 * multiply the app category's volume for noise the desktop-note watcher and
 * every other consumer of `foreground.ts` already treats as beneath the
 * sampling interval.
 */
function closeCurrent(now: number): void {
  if (!current) return;
  const durationMs = now - current.since;
  const { app: name, from, title, process: proc, browser } = current;
  current = null;
  // Sub-sample spans are switching noise (alt-tab through a stack of windows).
  // This is also the debounce: a rapid pass through five windows produces one
  // row for wherever the user actually settled, not five.
  if (durationMs >= SAMPLE_MS) {
    const detail: Record<string, string> = {};
    if (from) detail.from = from;
    if (title) detail.title = title;
    if (proc) detail.process = proc;
    if (browser) detail.browser = browser;
    push({
      action: "app.focus",
      category: "app",
      occurredAt: new Date(now - durationMs).toISOString(),
      targetKind: "app",
      targetId: name,
      durationMs,
      ...(Object.keys(detail).length ? { detail } : {}),
    });
  }
}

async function sample(): Promise<void> {
  if (!isActive()) return;
  const now = Date.now();

  // OS-level idle first: time spent away from the keyboard is not time spent in
  // whatever app happens to be frontmost, and crediting it there would make a
  // person look busy in an app they walked away from.
  const idleFor = powerMonitor.getSystemIdleTime();
  if (idleFor >= IDLE_AFTER_S) {
    if (idleSince === null) {
      idleSince = now;
      closeCurrent(now);
      push({ action: "idle.start", category: "system", occurredAt: stamp() });
    }
    return;
  }
  if (idleSince !== null) {
    push({
      action: "idle.end",
      category: "system",
      occurredAt: stamp(),
      durationMs: now - idleSince,
    });
    idleSince = null;
  }

  const win = await loadProvider();
  if (!win) return; // presence-only mode

  let name: string | undefined;
  let title: string | null = null;
  let proc: string | null = null;
  try {
    const active = await win.activeWindow();
    name = active?.owner?.name;
    // Title and process are read defensively and independently of `name`: a
    // window that cannot be fully described (an elevated process the sensor
    // has no rights to inspect, a window mid-close, a title the OS declines to
    // return) still reports what it DOES know rather than nothing at all. An
    // absent title is not an error here — most windows have one, some
    // legitimately do not, and the row simply carries no `detail.title` for it
    // (see `closeCurrent`, which omits empty fields rather than sending "").
    const rawTitle = active?.title?.trim();
    title = rawTitle ? rawTitle : null;
    // Feeds the ground-truth half of macOS's permission story (see
    // macos-permissions.ts's `titleReadWorking`) — a no-op on every other
    // platform. Recorded only when there IS a frontmost app to have a title
    // at all; a read that found no window yet is not evidence about the
    // Screen Recording grant either way.
    if (active?.owner?.name) recordTitleObservation(!!rawTitle);
    // `owner.path` is a Windows-style path on Windows and a POSIX-style path on
    // macOS/Linux. Node's platform-default `path` module parses whichever style
    // matches the HOST running this code, which is correct in production (the
    // desktop app only ever runs on the OS it is packaged for) but would silently
    // mis-parse a Windows path under a POSIX-hosted test — so both parsers are
    // tried and whichever actually split the path into a directory and a
    // filename wins, rather than trusting `process.platform` alone.
    const path = active?.owner?.path;
    proc = path ? basename(path).replace(/\.(exe|app)$/i, "") : null;
  } catch {
    return; // a transient failure to read the foreground window is not an error
  }
  if (!name) return;

  if (current?.app !== name) {
    // Read BEFORE closing, because closeCurrent clears it. The app being left is
    // the app the next span came from — reported as the marker when it is
    // BlissWork's own window, since a reader cannot recognise the packaged
    // executable's name as us.
    const leaving = current ? (isSelf(current.app) ? SELF : current.app) : null;
    closeCurrent(now);
    // `browserSlug` is checked against the RESOLVED name (what a reader would
    // recognise — "Google Chrome", not "chrome.exe"), so a browser this sensor
    // has never heard of by executable name still gets no false positive: an
    // unrecognised app is just an app, exactly like everywhere else this
    // codebase resolves a foreground reading (see activityDestination.ts).
    current = {
      app: name,
      since: now,
      from: leaving,
      title,
      process: proc && proc.toLowerCase() !== name.toLowerCase() ? proc : null,
      browser: browserSlug(resolveApp(name)),
    };
  }
}

async function flush(): Promise<void> {
  const state = getState();
  if (!state.token || !telemetryBase || queue.length === 0) return;
  const batch = queue.slice(0, 200);
  queue = queue.slice(batch.length);
  try {
    const res = await fetch(`${telemetryBase}/telemetry/ingest/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Ingest-Token": state.token },
      body: JSON.stringify({ events: batch }),
    });
    // 401 means the token was revoked — by the person, or automatically because
    // their membership ended. Stop rather than retry: there is nothing to
    // recover, and re-sending would be a removed member's laptop repeatedly
    // trying to report into a workspace it no longer belongs to.
    if (res.status === 401) {
      queue = [];
      stop();
      return;
    }
    if (!res.ok) queue = [...batch, ...queue].slice(-MAX_QUEUED);
  } catch {
    queue = [...batch, ...queue].slice(-MAX_QUEUED); // offline; try again later
  }
}

function onLock(): void {
  if (!isActive()) return;
  closeCurrent(Date.now());
  push({ action: "screen.locked", category: "system", occurredAt: stamp() });
  void flush();
}

function onUnlock(): void {
  if (!isActive()) return;
  push({ action: "screen.unlocked", category: "system", occurredAt: stamp() });
}

function onSuspend(): void {
  if (!isActive()) return;
  closeCurrent(Date.now());
  push({ action: "system.suspended", category: "system", occurredAt: stamp() });
  // Flush before the machine sleeps: the lid is about to close and this is the
  // last chance to say anything.
  void flush();
}

/**
 * Record a detected screenshot attempt. Returns whether it was recorded.
 *
 * Flushed immediately rather than batched, for the same reason as onSuspend:
 * an attempt to capture protected content is the kind of event that is worth
 * nothing if it arrives after the machine is gone.
 *
 * No-op without consent, like every other push here. That is the deliberate
 * trade — a user who declined the activity agent still SEES the warning, we
 * just do not write a monitoring record about someone who declined monitoring.
 *
 * The RETURN VALUE is what keeps that trade from also losing the security
 * record: false tells the renderer to report the attempt itself, through the
 * ordinary session beacon every signed-in client already sends. So the attempt
 * is recorded either way, and never twice.
 */
export function recordScreenshotAttempt(): boolean {
  if (!isActive()) return false;
  push({ action: "screenshot.attempted", category: "system", occurredAt: stamp() });
  void flush();
  return true;
}

/** Start sampling. Idempotent — safe to call whenever consent changes. */
export function start(base: string): void {
  telemetryBase = base;
  if (!isActive()) return;
  if (sampleTimer) return;
  sampleTimer = setInterval(() => void sample(), SAMPLE_MS);
  flushTimer = setInterval(() => void flush(), FLUSH_MS);
  powerMonitor.on("lock-screen", onLock);
  powerMonitor.on("unlock-screen", onUnlock);
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onUnlock);
}

/** Stop sampling and forget anything unsent. Called on withdrawal of consent,
 *  on unpair, and on a 401 — in every case the buffered spans belong to a
 *  relationship that has ended. */
export function stop(): void {
  if (sampleTimer) clearInterval(sampleTimer);
  if (flushTimer) clearInterval(flushTimer);
  sampleTimer = null;
  flushTimer = null;
  current = null;
  idleSince = null;
  queue = [];
  powerMonitor.removeListener("lock-screen", onLock);
  powerMonitor.removeListener("unlock-screen", onUnlock);
  powerMonitor.removeListener("suspend", onSuspend);
  powerMonitor.removeListener("resume", onUnlock);
}

/** Re-evaluate after a consent or token change. */
export function reconcile(base: string): void {
  if (isActive()) start(base);
  else stop();
}

/** Last flush before the app exits, so a day's final span is not lost. */
export async function flushOnQuit(): Promise<void> {
  if (!isActive()) return;
  closeCurrent(Date.now());
  await flush();
}

/**
 * What the Settings screen needs to render honestly.
 *
 * `appTracking`/`reason` are unchanged from before this platform's addition —
 * they answer "does foreground reading work AT ALL" (app name + process), and
 * on macOS that is TRUE regardless of Screen Recording, per
 * macos-permissions.ts's docstring on what is and is not gated.
 *
 * `titleTracking` is the new, NARROWER answer: does the window-TITLE half
 * additionally work. Always `true` on Windows/Linux (nothing gates it there);
 * on macOS it reflects the Screen Recording grant. `titleTrackingReason` is
 * only ever set when `titleTracking` is false, so a caller can render "app
 * tracking works; add window titles by granting Screen Recording" rather than
 * treating the whole feature as unavailable.
 */
export async function capability(): Promise<{
  appTracking: boolean;
  reason: string | null;
  titleTracking: boolean;
  titleTrackingReason: string | null;
}> {
  const win = await loadProvider();
  const appTracking = !!win;
  if (!appTracking) {
    // No provider at all: title tracking cannot be evaluated meaningfully —
    // it is moot, not "denied". Reported as unavailable for the SAME reason
    // as app tracking, since granting Screen Recording would not help.
    return {
      appTracking, reason: providerUnavailableReason(),
      titleTracking: false, titleTrackingReason: providerUnavailableReason(),
    };
  }
  if (process.platform !== "darwin") {
    return { appTracking, reason: null, titleTracking: true, titleTrackingReason: null };
  }
  const status = await screenRecordingStatus();
  const titleTracking = status === "granted";
  return {
    appTracking, reason: null,
    titleTracking,
    titleTrackingReason: titleTracking ? null : describeStatus(status),
  };
}
