/**
 * Pure state machine: foreground-application and OS-idle snapshots in, closed
 * activity spans out.
 *
 * No Electron, native code, timers, I/O or clock — every timestamp arrives on
 * the input and the whole thing is `(state, input) → (state, events)`, so a
 * test can replay a day in microseconds. The caller owns polling (it feeds one
 * `sample` per tick, e.g. from `getForegroundApp` + `powerMonitor`) and the
 * lifecycle signals; this owns only what those mean.
 *
 * ── Output: closed spans, one event each ────────────────────────────────────
 * A span is reported once, when it ends, carrying its start, end and duration —
 * the same shape the old activity agent used for `app.focus` (one row, start as
 * `occurredAt`, plus `durationMs`). There is no separate "start" event to
 * duplicate or lose, and an open span is simply state until it closes. A
 * non-positive span is never emitted.
 *
 * ── Idle is backdated to the last input ─────────────────────────────────────
 * `idleSeconds` is time since the last input, so when a sample first reports
 * idle at or above the threshold the user actually went idle `idleSeconds`
 * ago, not now. The app span is closed there and the idle span starts there —
 * crediting the quiet minutes before detection to the app would flatter every
 * span. Backdating never reaches before the open span's start (or, with no
 * span, the previous input), so nothing is claimed about time the tracker did
 * not observe. Likewise a return to activity is stamped at the last input, not
 * at the sample that noticed it.
 *
 * ── Lock and suspend pause tracking ─────────────────────────────────────────
 * Both close whatever is open at that instant and ignore samples until the
 * matching unlock/resume. They are tracked separately, so a machine that
 * resumes while still locked stays paused. A paused period yields no span at
 * all: it is not application time and not "idle" either, just absence.
 *
 * ── Rollover: a long span is delivered in instalments ──────────────────────
 * Spans are reported when they close, so one application held in front for
 * hours would be reported only at the end — and lost with everything else on a
 * crash, and (past a day) rejected by the server. With `maxAppSpanMs` set, an
 * UNCHANGED foreground application is closed every `maxAppSpanMs` and reopened
 * at the same instant: the pieces abut exactly and their durations sum to the
 * continuous period. It is bookkeeping, not an event — no switch, no idle, and
 * the idle/lock/suspend/quit rules above are unaffected.
 *
 * Boundaries are exact (`since + maxAppSpanMs`), not wherever a sample happened
 * to land, and a roll only commits time up to the user's last INPUT. A span
 * that is closed cannot be recalled, and an idle period is backdated to the last
 * input; rolling up to "now" could therefore bank as active up to a whole idle
 * threshold of minutes that the next sample then reveals to have been quiet.
 * Idle is checked first, so an app span is never rolled while the user is idle.
 *
 * Off unless the option is set — the machine itself assumes nothing about how
 * its caller wants spans delivered.
 *
 * Identity is the executable's name and path only (case-insensitive, as
 * Windows paths are). Nothing else about a window is ever carried.
 */

export interface AppIdentity {
  /** Executable file name, e.g. `chrome.exe`. */
  name: string;
  /** Full executable path. */
  path: string;
}

/** A closed span in which one application was in front and the user was active. */
export interface AppSpan extends AppIdentity {
  kind: "app";
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

/** A closed span in which the OS reported no input for at least the idle threshold. */
export interface IdleSpan {
  kind: "idle";
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export type ActivityEvent = AppSpan | IdleSpan;

export type TrackerInput =
  | {
      type: "sample";
      /** Epoch ms of this reading. */
      at: number;
      /** The foreground application, or null when none (lock screen, UAC, unreadable). */
      app: AppIdentity | null;
      /** Seconds since the last user input, from the OS. */
      idleSeconds: number;
    }
  | { type: "lock" | "unlock" | "suspend" | "resume" | "quit"; at: number };

export interface TrackerOptions {
  /** Idle at or above this many seconds is idle. Matches the old agent and the web client. */
  idleThresholdSeconds: number;
  /**
   * Close and reopen an unchanged foreground application once its open span
   * reaches this long (see "Rollover" above). Absent, zero or non-finite: never.
   */
  maxAppSpanMs?: number;
}

export const DEFAULT_OPTIONS: TrackerOptions = { idleThresholdSeconds: 300 };

/** The rollover interval the desktop app runs with. Five minutes bounds what an unclean exit can lose to that much, and keeps every span far under the server's 24h limit. */
export const DEFAULT_MAX_APP_SPAN_MS = 5 * 60_000;
/** Most spans one sample may roll off after a long stall; the rest carry into the open span and roll on the next. */
const MAX_ROLLS_PER_SAMPLE = 288;

export interface TrackerState {
  /** The open foreground-app span, if any. */
  readonly app: (AppIdentity & { readonly since: number }) | null;
  /** When the open idle span began, if one is open. */
  readonly idleSince: number | null;
  readonly locked: boolean;
  readonly suspended: boolean;
  /** Latest timestamp seen — input times are clamped to it so time never runs backwards. */
  readonly lastAt: number | null;
}

export interface TrackerStep {
  state: TrackerState;
  events: ActivityEvent[];
}

export const initialState: TrackerState = {
  app: null,
  idleSince: null,
  locked: false,
  suspended: false,
  lastAt: null,
};

/** Whether two readings are the same application. */
export function sameApp(a: AppIdentity, b: AppIdentity): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase() && a.path.toLowerCase() === b.path.toLowerCase();
}

const appSpan = (app: AppIdentity, startedAt: number, endedAt: number): AppSpan => ({
  kind: "app", name: app.name, path: app.path, startedAt, endedAt, durationMs: endedAt - startedAt,
});

function closeApp(state: TrackerState, at: number): ActivityEvent[] {
  const open = state.app;
  if (!open) return [];
  const durationMs = at - open.since;
  if (durationMs <= 0) return [];
  return [appSpan(open, open.since, at)];
}

/**
 * Roll an unchanged application's open span over each `maxAppSpanMs`, as far as
 * `activeUntil` (the last input) verifies. No-op unless due.
 */
function rollOver(state: TrackerState, activeUntil: number, maxAppSpanMs: number | undefined): TrackerStep {
  const open = state.app;
  // Absent, zero or NaN is off; a negative or infinite interval yields no rolls below.
  if (!open || !maxAppSpanMs) return { state, events: [] };
  const rolls = Math.min(Math.floor((activeUntil - open.since) / maxAppSpanMs), MAX_ROLLS_PER_SAMPLE);
  if (rolls < 1) return { state, events: [] };
  const events: ActivityEvent[] = [];
  for (let i = 0; i < rolls; i++) {
    const start = open.since + i * maxAppSpanMs;
    events.push(appSpan(open, start, start + maxAppSpanMs));
  }
  return { state: { ...state, app: { ...open, since: open.since + rolls * maxAppSpanMs } }, events };
}

function closeIdle(state: TrackerState, at: number): ActivityEvent[] {
  if (state.idleSince === null) return [];
  const durationMs = at - state.idleSince;
  if (durationMs <= 0) return [];
  return [{ kind: "idle", startedAt: state.idleSince, endedAt: at, durationMs }];
}

const open = (app: AppIdentity | null, since: number): TrackerState["app"] =>
  app ? { name: app.name, path: app.path, since } : null;

/** Advance the machine by one input. Never mutates `state`. */
export function step(
  state: TrackerState,
  input: TrackerInput,
  options: TrackerOptions = DEFAULT_OPTIONS,
): TrackerStep {
  // Time only moves forward: a clock that steps back is treated as no time passing.
  const at = Math.max(input.at, state.lastAt ?? input.at);
  const previousAt = state.lastAt ?? at;
  const seen = { ...state, lastAt: at };

  switch (input.type) {
    case "lock":
    case "suspend": {
      const events = [...closeApp(seen, at), ...closeIdle(seen, at)];
      const paused = { ...seen, app: null, idleSince: null };
      return { state: input.type === "lock" ? { ...paused, locked: true } : { ...paused, suspended: true }, events };
    }
    case "unlock":
      return { state: { ...seen, locked: false }, events: [] };
    case "resume":
      return { state: { ...seen, suspended: false }, events: [] };
    case "quit":
      return { state: { ...initialState, lastAt: at }, events: [...closeApp(seen, at), ...closeIdle(seen, at)] };
    case "sample":
      return seen.locked || seen.suspended ? { state: seen, events: [] } : sample(seen, input, at, previousAt, options);
  }
}

function sample(
  state: TrackerState,
  input: Extract<TrackerInput, { type: "sample" }>,
  at: number,
  previousAt: number,
  options: TrackerOptions,
): TrackerStep {
  const idleMs = Number.isFinite(input.idleSeconds) ? Math.max(0, input.idleSeconds) * 1000 : 0;
  // When the user last touched the machine, bounded to what we actually observed.
  const lastInputAt = (floor: number) => Math.min(at, Math.max(at - idleMs, floor));

  if (input.idleSeconds >= options.idleThresholdSeconds) {
    if (state.idleSince !== null) return { state, events: [] }; // still idle
    // With no open span the floor is the previous reading: never claim idle
    // time from before the tracker was looking.
    const idleStart = lastInputAt(state.app?.since ?? previousAt);
    return {
      state: { ...state, app: null, idleSince: idleStart },
      events: closeApp(state, idleStart),
    };
  }

  if (state.idleSince !== null) {
    // Back to activity. The user returned at their last input; the application
    // now in front is the one that resumes from that moment.
    const returnedAt = lastInputAt(state.idleSince);
    return {
      state: { ...state, idleSince: null, app: open(input.app, returnedAt) },
      events: closeIdle(state, returnedAt),
    };
  }

  const current = state.app;
  if (!input.app) return { state: { ...state, app: null }, events: closeApp(state, at) };
  if (current && sameApp(current, input.app)) return rollOver(state, at - idleMs, options.maxAppSpanMs);
  return { state: { ...state, app: open(input.app, at) }, events: closeApp(state, at) };
}
