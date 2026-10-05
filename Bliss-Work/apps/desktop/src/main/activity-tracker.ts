import {
  DEFAULT_OPTIONS,
  initialState,
  step,
  type ActivityEvent,
  type AppIdentity,
  type TrackerInput,
  type TrackerOptions,
  type TrackerState,
} from "./activity-spans";

/**
 * Drives the pure span machine (activity-spans.ts) from the Electron main
 * process: polls the foreground application and the OS idle time on one
 * interval, forwards power signals, and hands every COMPLETED span to
 * `onEvents`. It decides nothing about what a span is — that is all in the
 * machine — and sends nothing anywhere; what `onEvents` does is the caller's.
 *
 * Everything it touches is injected (clock, foreground reader, idle reader,
 * power source), so the tests run it without Electron, Windows or real time.
 * It reads no input: idle comes from the OS's own counter, never from hooks.
 *
 * ── Why 3 seconds ───────────────────────────────────────────────────────────
 * The foreground window has to be polled (Win32 offers no cheap "another app
 * came to the front" event), so the interval is the resolution of every app
 * switch: a span boundary can be off by up to one interval. 3s keeps that
 * error small against the minutes-long spans anyone looks at, treats an
 * alt-tab flicker shorter than it as the noise it is, and costs a few
 * syscalls per tick. Idle precision does not depend on it — the machine
 * backdates idle using the OS's own seconds-since-last-input.
 */
export const SAMPLE_INTERVAL_MS = 3_000;

type PowerSignal = "lock-screen" | "unlock-screen" | "suspend" | "resume";

const SIGNALS: Record<PowerSignal, Exclude<TrackerInput["type"], "sample" | "quit">> = {
  "lock-screen": "lock",
  "unlock-screen": "unlock",
  suspend: "suspend",
  resume: "resume",
};

/** The slice of Electron's `powerMonitor` this needs. */
export interface PowerSource {
  on(event: PowerSignal, listener: () => void): unknown;
  removeListener(event: PowerSignal, listener: () => void): unknown;
}

export interface ActivityTrackerDeps {
  /** The application in front right now, or null. Called once per tick. */
  readForeground: (at: number) => Promise<AppIdentity | null>;
  /** Seconds since the last user input (`powerMonitor.getSystemIdleTime`). */
  readIdleSeconds: () => number;
  now: () => number;
  power: PowerSource;
  /** Receives each batch of completed spans. Never called with an empty batch. */
  onEvents: (events: ActivityEvent[]) => void;
  sampleIntervalMs?: number;
  idleThresholdSeconds?: number;
  /** Close and reopen an unchanged foreground app this often (see activity-spans.ts "Rollover"). Absent: never. */
  maxAppSpanMs?: number;
}

export interface ActivityTracker {
  /** Begin tracking. A second call while running does nothing. */
  start(): void;
  /** Close any open span (delivering it), then release every timer and listener. Idempotent. */
  stop(): void;
  /** One sampling pass. Public so tests, and a caller wanting an immediate read, need no timer. */
  tick(): Promise<void>;
  readonly running: boolean;
}

export function createActivityTracker(deps: ActivityTrackerDeps): ActivityTracker {
  const { readForeground, readIdleSeconds, now, power, onEvents } = deps;
  const intervalMs = deps.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
  const options: TrackerOptions = {
    ...DEFAULT_OPTIONS,
    ...(deps.idleThresholdSeconds !== undefined && { idleThresholdSeconds: deps.idleThresholdSeconds }),
    ...(deps.maxAppSpanMs !== undefined && { maxAppSpanMs: deps.maxAppSpanMs }),
  };

  let state: TrackerState = initialState;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  /** Bumped on every start/stop so a read that outlives its run is discarded. */
  let run = 0;
  const listeners = new Map<PowerSignal, () => void>();

  /** Feed one input to the machine and deliver whatever it closed. A throwing consumer must not stop tracking or a quit. */
  function feed(input: TrackerInput): void {
    const next = step(state, input, options);
    state = next.state;
    if (next.events.length === 0) return;
    try {
      onEvents(next.events);
    } catch (err) {
      console.warn("[activity] onEvents failed:", err instanceof Error ? err.message : err);
    }
  }

  async function tick(): Promise<void> {
    // A slow read must not stack a second one behind it.
    if (!timer || inFlight) return;
    inFlight = true;
    const mine = run;
    try {
      const at = now();
      const idleSeconds = readIdleSeconds();
      const app = await readForeground(at).catch(() => null);
      // Stopped, or restarted, while reading: this reading belongs to a run that is over.
      if (mine !== run) return;
      feed({ type: "sample", at, app, idleSeconds });
    } catch {
      // An unreadable idle counter skips this tick; the next one tries again.
    } finally {
      if (mine === run) inFlight = false;
    }
  }

  return {
    get running() {
      return timer !== null;
    },
    tick,
    start() {
      if (timer) return;
      run++;
      state = initialState;
      for (const [signal, type] of Object.entries(SIGNALS) as [PowerSignal, (typeof SIGNALS)[PowerSignal]][]) {
        const listener = () => feed({ type, at: now() });
        listeners.set(signal, listener);
        power.on(signal, listener);
      }
      timer = setInterval(() => void tick(), intervalMs);
      void tick(); // open the first span now rather than one interval from now
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      run++;
      for (const [signal, listener] of listeners) power.removeListener(signal, listener);
      listeners.clear();
      // Last, after the listeners are gone: delivers the open span and resets the machine.
      feed({ type: "quit", at: now() });
      state = initialState;
      inFlight = false;
    },
  };
}
