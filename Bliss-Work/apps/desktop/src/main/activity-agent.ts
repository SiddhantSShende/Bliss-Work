import { powerMonitor } from "electron";
import { isActive, getState } from "./activity-state";

/**
 * The desktop activity agent.
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
 *   2. FOREGROUND APPLICATION — which app is in front, by NAME. Electron has no
 *      API for this, so it needs a native module. Loaded dynamically: if it is
 *      not installed the agent still runs with capability (1) and reports the
 *      absence, rather than failing to start. That keeps the dependency
 *      optional, which matters because `desktop-builder` cross-builds Windows
 *      under Wine and cannot compile a node-gyp addon.
 *
 * Window TITLES are never read — only the application name. Titles routinely
 * contain document names, customer names and password-manager entries, and on
 * macOS reading them would additionally require an Accessibility (TCC) grant.
 *
 * Everything here runs in the MAIN process and posts straight to the server with
 * a pairing token. Sampled data never passes through the renderer, so an XSS in
 * the web layer cannot read it and closing every window does not stop it.
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
}

interface ForegroundWindow {
  owner?: { name?: string };
}

type GetWindows = { activeWindow: () => Promise<ForegroundWindow | undefined> };

let telemetryBase = "";
let queue: AgentEvent[] = [];
let sampleTimer: NodeJS.Timeout | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let current: { app: string; since: number } | null = null;
let idleSince: number | null = null;
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
async function loadProvider(): Promise<GetWindows | null> {
  if (providerChecked) return provider;
  providerChecked = true;
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
    providerError = "Wayland does not expose the active window";
    return null;
  }
  try {
    // The specifier is a VARIABLE, not a literal, and deliberately so: a literal
    // would make `get-windows` a hard build-time dependency — TypeScript would
    // demand its types and the bundler would try to inline it — when the whole
    // design is that it is optional. This keeps it a runtime lookup that simply
    // fails on a build where it was not installed.
    const specifier = "get-windows";
    provider = (await import(/* @vite-ignore */ specifier)) as GetWindows;
  } catch {
    provider = null;
    providerError = "app tracking is not installed in this build";
  }
  return provider;
}

function push(e: AgentEvent): void {
  queue.push(e);
  // Drop the OLDEST: after a long offline stretch the recent minutes are the
  // ones anyone looking at the timeline wants.
  if (queue.length > MAX_QUEUED) queue = queue.slice(-MAX_QUEUED);
}

function stamp(): string {
  return new Date().toISOString();
}

/** Close the open foreground span and record it. */
function closeCurrent(now: number): void {
  if (!current) return;
  const durationMs = now - current.since;
  const name = current.app;
  current = null;
  // Sub-sample spans are switching noise (alt-tab through a stack of windows).
  if (durationMs >= SAMPLE_MS) {
    push({
      action: "app.focus",
      category: "app",
      occurredAt: new Date(now - durationMs).toISOString(),
      targetKind: "app",
      targetId: name,
      durationMs,
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
  try {
    const active = await win.activeWindow();
    name = active?.owner?.name;
  } catch {
    return; // a transient failure to read the foreground window is not an error
  }
  if (!name) return;

  if (current?.app !== name) {
    closeCurrent(now);
    current = { app: name, since: now };
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

/** What the Settings screen needs to render honestly. */
export async function capability(): Promise<{ appTracking: boolean; reason: string | null }> {
  const win = await loadProvider();
  return { appTracking: !!win, reason: win ? null : providerError };
}
